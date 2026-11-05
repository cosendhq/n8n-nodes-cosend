import type { IExecuteFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { upsertContact } from '../nodes/Cosend/operations/upsertContact';
import { createExecuteContext, httpError } from './fakes';

const asExecute = (context: unknown) => context as IExecuteFunctions;

const CONTACT = { id: 'ct_01K3F8XK3M9PQRSTVWXYZ01ABC', object: 'contact', tags: [] };

const item = (additionalFields: Record<string, unknown> = {}) => ({
	connectionId: { mode: 'list', value: 'conn_01K3F8XK3M9PQRSTVWXYZ01ABC' },
	phoneE164: '+919876543210',
	additionalFields,
});

describe('Contact: Upsert', () => {
	// Catches: a second request for a contact the POST just created with every field already set.
	it('creates a new contact with its fields in one request', async () => {
		const context = createExecuteContext({
			items: [item({ profileName: 'Priya', tags: 'vip, india' })],
			respond: () => ({ statusCode: 201, body: { ...CONTACT, profile_name: 'Priya' } }),
		});

		const [output] = await upsertContact.call(asExecute(context));

		expect(context.requests).toHaveLength(1);
		expect(context.requests[0]).toMatchObject({
			method: 'POST',
			url: 'https://api.cosend.app/v1/contacts',
			body: {
				connection_id: 'conn_01K3F8XK3M9PQRSTVWXYZ01ABC',
				phone_e164: '+919876543210',
				profile_name: 'Priya',
				tags: ['vip', 'india'],
			},
		});
		expect(output).toEqual([
			{ json: { ...CONTACT, profile_name: 'Priya' }, pairedItem: { item: 0 } },
		]);
		expect(context.logs.map((line) => line.message)).toEqual([
			'Cosend upsert created a new contact',
		]);
	});

	/**
	 * **Catches: an "upsert" that never writes.**
	 *
	 * A2 §5.6 answers a create for an existing number with that contact, `200`, UNCHANGED. A node
	 * that stopped at the POST would report success while every field the workflow sent was
	 * dropped — which is exactly what the Create operation's old description promised it would
	 * not do.
	 */
	it('updates an existing contact with the same fields', async () => {
		const context = createExecuteContext({
			items: [item({ profileName: 'Priya', attributes: '{"crm_id":"4821"}' })],
			respond: (request) =>
				request.method === 'POST'
					? { statusCode: 200, body: CONTACT }
					: { ...CONTACT, profile_name: 'Priya', attributes: { crm_id: '4821' } },
		});

		const [output] = await upsertContact.call(asExecute(context));

		expect(context.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			'POST https://api.cosend.app/v1/contacts',
			`PATCH https://api.cosend.app/v1/contacts/${CONTACT.id}`,
		]);
		// The PATCH carries the fields and nothing else: `patchContactRequest` is `.strict()` and
		// has no `connection_id` or `phone_e164`.
		expect(context.requests[1]?.body).toEqual({
			profile_name: 'Priya',
			attributes: { crm_id: '4821' },
		});
		expect(output?.[0]?.json).toMatchObject({ profile_name: 'Priya' });
		expect(context.logs).toEqual([
			{
				level: 'info',
				message: 'Cosend upsert updated the existing contact',
				meta: { contactId: CONTACT.id, fields: 'attributes,profile_name', itemIndex: 0 },
			},
		]);
	});

	it('stops at the lookup when it found the contact and there is nothing to write', async () => {
		const context = createExecuteContext({
			items: [item()],
			respond: () => ({ statusCode: 200, body: CONTACT }),
		});

		const [output] = await upsertContact.call(asExecute(context));

		expect(context.requests).toHaveLength(1);
		expect(output?.[0]?.json).toEqual(CONTACT);
	});

	// Catches: an answer with no contact in it becoming a PATCH to `/contacts/undefined`.
	it('stops with a plain error when the answer holds no contact', async () => {
		const context = createExecuteContext({
			items: [item({ profileName: 'Priya' })],
			respond: () => ({ statusCode: 200, body: '' }),
		});

		await expect(upsertContact.call(asExecute(context))).rejects.toThrow(
			'Cosend answered without a contact',
		);
		expect(context.requests).toHaveLength(1);
	});

	// Catches: a malformed JSON field reaching the API as a string, or failing without saying which.
	it('names the Attributes field when it is not valid JSON, and sends nothing', async () => {
		const context = createExecuteContext({ items: [item({ attributes: '{ not json' })] });

		await expect(upsertContact.call(asExecute(context))).rejects.toThrow(/'Attributes'/);
		expect(context.requests).toHaveLength(0);
	});

	// Catches: a refused item losing the code and request id cosend.app/docs/n8n promises.
	it('keeps going on a refusal when told to, with the code and request id on the item', async () => {
		const context = createExecuteContext({
			items: [item()],
			continueOnFail: true,
			respond: () => {
				throw httpError(400, 'invalid_request', 'That number cannot be reached on WhatsApp.');
			},
		});

		const [output] = await upsertContact.call(asExecute(context));

		expect(output).toEqual([
			{
				json: {
					error: 'That number cannot be reached on WhatsApp.',
					code: 'invalid_request',
					request_id: 'req_test',
				},
				pairedItem: { item: 0 },
			},
		]);
	});
});
