import { randomUUID } from 'crypto';
import type { IDataObject, IExecuteFunctions, INodeExecutionData, JsonObject } from 'n8n-workflow';

import {
	cosendApiError,
	cosendApiRequest,
	cosendFailureOf,
	failureJson,
	failureJsonOf,
} from '../shared/transport';
import { buildMessageBody, idempotencyKeyFor } from './messageBody';

/** A2 §5.4: "accepts up to 100 messages". The cap is a contract, not a guess. */
export const BATCH_MAX = 100;

/** The endpoint this operation posts to. Exported for `test/contract.test.ts` — see sendMessage. */
export const BATCH_ENDPOINT = '/messages/batch';

interface BatchResult {
	index: number;
	status: number;
	id?: string;
	error?: { type: string; code: string; message: string; request_id?: string };
}

/**
 * `message:sendBatch` — every input item in one request, in chunks of 100.
 *
 * **Why this exists as its own operation rather than a `Batch Size` option on Send.** The route
 * table marks `POST /v1/messages/batch` as `n8n: { resource: 'message', operation: 'sendBatch' }`,
 * so the contract names it an operation. Doc 03 §4.7 imagined it as an option; the marker is what
 * the generator publishes and what the drift test checks.
 *
 * **The `207` results array is positional, and that is why this can keep `pairedItem` honest.**
 * A2 §5.4 returns an indexed array rather than a map precisely because n8n's item model is
 * positional — anything else would force a correlation key to be invented here.
 *
 * Cosend shapes the send rate per connection server-side and sends the items one at a time, so a
 * batch never exceeds Meta's ceiling. That is the API's job, not this node's: there is no pacing,
 * no sleeping and no retry loop in here.
 */
export async function sendBatch(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = new Array<INodeExecutionData>(items.length);

	// Bodies first, all of them: a binary attachment uploads here, and an item that cannot be
	// built must not take the whole chunk down with it.
	const bodies: (IDataObject | undefined)[] = [];
	for (let i = 0; i < items.length; i++) {
		try {
			const body = await buildMessageBody(this, i);
			body.idempotency_key = idempotencyKeyFor(this, i, randomUUID());
			bodies.push(body);
		} catch (error) {
			if (!this.continueOnFail()) {
				// Already a NodeOperationError from `buildMessageBody`, or a NodeApiError from the
				// media upload inside it. Named rather than re-thrown so the intent is legible.
				const failure = error;
				throw failure;
			}
			bodies.push(undefined);
			results[i] = { json: failureJsonOf(error), pairedItem: { item: i } };
		}
	}

	for (let start = 0; start < bodies.length; start += BATCH_MAX) {
		// The chunk carries the ORIGINAL item index alongside the body, because a chunk with a
		// failed build in it is shorter than the slice it came from — and the `207` results are
		// indexed against what was sent, not against the input.
		const chunk = bodies
			.slice(start, start + BATCH_MAX)
			.map((body, offset) => ({ body, itemIndex: start + offset }))
			.filter(
				(entry): entry is { body: IDataObject; itemIndex: number } => entry.body !== undefined,
			);

		if (chunk.length === 0) continue;

		const response = (await cosendApiRequest.call(
			this,
			'POST',
			BATCH_ENDPOINT,
			{ messages: chunk.map((entry) => entry.body) },
			{},
			{
				headers: {
					Accept: 'application/json',
					// The request-level key covers the batch as a whole; each item carries its own
					// `idempotency_key`. Both are set, so neither a retried batch nor a retried item
					// duplicates a message.
					'Idempotency-Key': randomUUID(),
				},
			},
		)) as unknown as { results: BatchResult[] };

		for (const result of response.results ?? []) {
			const entry = chunk[result.index];
			if (entry === undefined) continue;

			if (result.error === undefined) {
				results[entry.itemIndex] = {
					json: { id: result.id, status: result.status } as JsonObject,
					pairedItem: { item: entry.itemIndex },
				};
				continue;
			}

			// A row's error is A2 §3.4's `error` member on its own, so it is read as one.
			const failure = cosendFailureOf({ error: result.error });
			if (this.continueOnFail()) {
				results[entry.itemIndex] = {
					json: failureJson(result.error.message, failure),
					pairedItem: { item: entry.itemIndex },
				};
				continue;
			}

			throw cosendApiError(this.getNode(), result.error as unknown as JsonObject, failure, {
				fallbackMessage: result.error.message,
				itemIndex: entry.itemIndex,
			});
		}
	}

	// A `207` that omits a row leaves a hole. Filling it with an explicit "no result" is the
	// honest shape: n8n would otherwise emit `undefined` as an item and the workflow would read a
	// missing answer as a successful one.
	for (let i = 0; i < results.length; i++) {
		if (results[i] === undefined) {
			results[i] = {
				json: { error: 'Cosend returned no result for this item' },
				pairedItem: { item: i },
			};
		}
	}

	return [results];
}
