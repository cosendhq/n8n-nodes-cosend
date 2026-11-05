import { createHmac } from 'crypto';
import type { IWebhookFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { CosendTrigger } from '../nodes/CosendTrigger/CosendTrigger.node';
import { createContext, type FakeContext } from './fakes';

const SECRET = 'whsec_live_the_one_this_node_stored';
const trigger = new CosendTrigger();
const asWebhook = (context: FakeContext) => context as unknown as IWebhookFunctions;

const sign = (rawBody: string, secret = SECRET) => {
	const t = Math.floor(Date.now() / 1000);
	return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
};

/**
 * A delivery whose raw bytes are NOT what `JSON.stringify` would produce for the same value:
 * the spacing after the colons and the non-ASCII character both change under a round trip.
 * Cosend's own outbound signer runs over the bytes it sends, so this is the realistic case, not
 * a contrived one.
 */
const RAW =
	'{"id": "evt_1", "object": "event", "type": "message.received", "data": {"object": {"id": "msg_1", "type": "text", "text": {"body": "hej så mycket"}}}}';

function deliver(rawBody: string, overrides: Record<string, unknown> = {}) {
	return createContext({
		staticData: { webhookId: 'whe_1', webhookSecret: SECRET },
		parameters: { options: {} },
		rawBody,
		body: JSON.parse(rawBody),
		headers: { 'cosend-signature': sign(rawBody) },
		...overrides,
	});
}

describe('CosendTrigger webhook', () => {
	it('emits the event when the signature is valid', async () => {
		const context = deliver(RAW);
		const result = await trigger.webhook.call(asWebhook(context));

		expect(result.workflowData).toHaveLength(1);
		expect(result.workflowData?.[0]).toHaveLength(1);
		expect(result.workflowData?.[0]?.[0]?.json).toMatchObject({
			id: 'msg_1',
			event: 'message.received',
			event_id: 'evt_1',
		});
	});

	/**
	 * Catches: verifying over `JSON.stringify(this.getBodyData())`.
	 *
	 * This is Doc 03 §5.12's own bug and the single most likely way to build a trigger that never
	 * fires. Re-serialising a parsed body changes spacing, escaping and number formatting, so the
	 * HMAC computed over it never matches the one Cosend computed over the bytes it sent — and
	 * every delivery is rejected as forged. This repo's inbound verifier says the same thing about
	 * Meta's webhooks: "Re-serialising loses Meta's exact escaping and the HMAC will never" match.
	 *
	 * The test is written so it can only pass if the raw bytes were used: the signature is over
	 * `RAW`, and `JSON.stringify(JSON.parse(RAW))` is a demonstrably different string.
	 */
	it('verifies against the raw bytes, not a re-serialisation of the parsed body', async () => {
		expect(JSON.stringify(JSON.parse(RAW))).not.toBe(RAW);

		const context = deliver(RAW);
		const result = await trigger.webhook.call(asWebhook(context));

		expect(result.workflowData).toBeDefined();
		expect(context.responseCalls.status).toBeUndefined();
	});

	// Catches: starting a workflow on an unverified delivery. Anyone who learns the webhook URL —
	// and it travels in plain sight — could otherwise drive the customer's automation.
	it('answers 401 and starts no workflow when the signature does not verify', async () => {
		const context = deliver(RAW, {
			headers: { 'cosend-signature': sign(RAW, 'whsec_live_not_ours') },
		});

		const result = await trigger.webhook.call(asWebhook(context));

		expect(result.workflowData).toBeUndefined();
		expect(result.noWebhookResponse).toBe(true);
		expect(context.responseCalls.status).toBe(401);
	});

	it('answers 401 when the signature header is absent altogether', async () => {
		const context = deliver(RAW, { headers: {} });
		const result = await trigger.webhook.call(asWebhook(context));

		expect(result.workflowData).toBeUndefined();
		expect(context.responseCalls.status).toBe(401);
	});

	// Catches: trusting a delivery because the node has no secret yet. An empty stored secret must
	// fail closed, never open.
	it('answers 401 when no signing secret was ever stored', async () => {
		const context = deliver(RAW, { staticData: { webhookId: 'whe_1' } });
		const result = await trigger.webhook.call(asWebhook(context));

		expect(result.workflowData).toBeUndefined();
		expect(context.responseCalls.status).toBe(401);
	});

	/**
	 * Catches: emitting `ping` as a workflow item.
	 *
	 * A2 §7.2 says `ping` is emitted only by `POST /v1/webhook-endpoints/{id}/test` — it is the
	 * dashboard's Test button. Running the customer's automation for it means a test click sends
	 * real WhatsApp messages.
	 */
	it('answers a ping without starting a workflow', async () => {
		const raw = '{"id":"evt_ping","object":"event","type":"ping","data":{"object":{}}}';
		const context = deliver(raw);

		const result = await trigger.webhook.call(asWebhook(context));

		expect(result.workflowData).toBeUndefined();
		expect(context.responseCalls.status).toBeUndefined();
	});

	it('returns the full envelope when Simplify is off', async () => {
		const context = deliver(RAW, { parameters: { options: { simplify: false } } });
		const result = await trigger.webhook.call(asWebhook(context));

		expect(result.workflowData?.[0]?.[0]?.json).toMatchObject({
			object: 'event',
			type: 'message.received',
			data: { object: { id: 'msg_1' } },
		});
	});
});

describe('CosendTrigger webhook filters', () => {
	/**
	 * Catches: filtering twice, in two places that can disagree.
	 *
	 * The filters are the endpoint's and Cosend applies them before it delivers. A signed delivery is
	 * one Cosend chose to send, so it starts the workflow.
	 */
	it('starts the workflow for a signed delivery whatever the node’s filters say', async () => {
		const context = deliver(RAW, {
			parameters: { filters: { messageTypes: ['image'] }, options: {} },
		});
		const result = await trigger.webhook.call(asWebhook(context));

		expect(result.workflowData?.[0]?.[0]?.json).toMatchObject({ id: 'msg_1' });
	});

	// Include Contact is applied by Cosend too: the contact arrives inside the conversation.
	it('passes on the contact Cosend included in a conversation event', async () => {
		const raw =
			'{"id":"evt_2","object":"event","type":"conversation.updated","data":{"object":{"id":"cnv_1","contact":{"id":"ct_1"}}}}';
		const result = await trigger.webhook.call(asWebhook(deliver(raw)));

		expect(result.workflowData?.[0]?.[0]?.json).toMatchObject({
			id: 'cnv_1',
			contact: { id: 'ct_1' },
		});
	});
});
