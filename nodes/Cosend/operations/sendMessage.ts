import { randomUUID } from 'crypto';
import type { IExecuteFunctions, INodeExecutionData, JsonObject } from 'n8n-workflow';

import { cosendApiRequest, failureItem, failureJsonOf, withItem } from '../shared/transport';
import { buildMessageBody, idempotencyKeyFor } from './messageBody';

/** The endpoint this operation posts to. Exported so `test/contract.test.ts` can check it
 *  against the generated fixture — a custom operation's path is invisible to the description. */
export const SEND_ENDPOINT = '/messages';

/**
 * `message:send` — one input item, one `POST /v1/messages`.
 *
 * A custom operation rather than routing because a binary attachment has to be uploaded first
 * (`POST /v1/media`), which is a second request the declarative layer cannot express. Everything
 * else about it is ordinary: one item in, one item out, `pairedItem` on every result.
 */
export async function sendMessage(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];

	for (let i = 0; i < items.length; i++) {
		try {
			const body = await buildMessageBody(this, i);
			const sent = await cosendApiRequest.call(
				this,
				'POST',
				SEND_ENDPOINT,
				body,
				{},
				{
					headers: {
						Accept: 'application/json',
						// A2 §3.3: required on this endpoint. A fresh UUID per item means two items in
						// one execution are two sends, while a user-supplied key makes a retry idempotent.
						'Idempotency-Key': idempotencyKeyFor(this, i, randomUUID()),
					},
				},
			);
			results.push({ json: sent as JsonObject, pairedItem: { item: i } });
		} catch (error) {
			if (this.continueOnFail()) {
				results.push(failureItem(this.getNode(), failureJsonOf(error), i));
				continue;
			}
			// Wrapped only if it is not already one of n8n's error classes: `cosendApiRequest`
			// raises `NodeApiError` and `buildMessageBody` raises `NodeOperationError`, and
			// wrapping either again would bury the message that names the actual problem.
			throw withItem(this.getNode(), error, i);
		}
	}

	return [results];
}
