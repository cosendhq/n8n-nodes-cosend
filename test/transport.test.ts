import type {
	IDataObject,
	IExecuteSingleFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IWorkflowDataProxyData,
} from 'n8n-workflow';
import { Expression } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { paginationProperties } from '../nodes/Cosend/shared/descriptions';
import {
	attachIdempotencyKey,
	cosendApiRequestAllItems,
	cosendFailureOf,
	explainCosendError,
	MAX_PAGE_SIZE,
} from '../nodes/Cosend/shared/transport';
import { createContext } from './fakes';

const singleContext = (options: Record<string, unknown>) =>
	({ getNodeParameter: () => options }) as unknown as IExecuteSingleFunctions;

describe('attachIdempotencyKey', () => {
	/**
	 * Catches: not sending the header at all.
	 *
	 * A2 §3.3 makes `Idempotency-Key` **required** on `POST /v1/messages`, `/messages/batch`,
	 * `/messages/{id}/reactions`, `/notifications` and `/schedules`. Without it the API answers
	 * `400 idempotency_key_required` — so an operation that omits it does not fail sometimes, it
	 * fails every single time.
	 */
	it('adds an Idempotency-Key when the user supplied none', async () => {
		const result = await attachIdempotencyKey.call(singleContext({}), {} as IHttpRequestOptions);

		expect(result.headers?.['Idempotency-Key']).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	// Catches: overwriting a caller's key. A stable key is the only way an n8n retry stops being
	// a second WhatsApp message, so the user's value has to win.
	it('uses the key the user supplied', async () => {
		const result = await attachIdempotencyKey.call(
			singleContext({ idempotencyKey: 'order-4821' }),
			{} as IHttpRequestOptions,
		);

		expect(result.headers?.['Idempotency-Key']).toBe('order-4821');
	});

	it('ignores a blank or whitespace-only key and generates one instead', async () => {
		for (const supplied of ['', '   ']) {
			const result = await attachIdempotencyKey.call(
				singleContext({ idempotencyKey: supplied }),
				{} as IHttpRequestOptions,
			);
			expect(result.headers?.['Idempotency-Key']).not.toBe(supplied);
			expect(String(result.headers?.['Idempotency-Key']).length).toBeGreaterThan(0);
		}
	});

	// Catches: a constant key. Two sends in one execution would collapse into one message, and
	// the second recipient would silently get nothing.
	it('generates a different key for each request', async () => {
		const first = await attachIdempotencyKey.call(singleContext({}), {} as IHttpRequestOptions);
		const second = await attachIdempotencyKey.call(singleContext({}), {} as IHttpRequestOptions);

		expect(first.headers?.['Idempotency-Key']).not.toBe(second.headers?.['Idempotency-Key']);
	});

	// Catches: replacing the headers object instead of extending it, which would drop `Accept`
	// and any auth header n8n had already put there.
	it('keeps the headers that were already set', async () => {
		const result = await attachIdempotencyKey.call(singleContext({}), {
			headers: { Accept: 'application/json' },
		} as unknown as IHttpRequestOptions);

		expect(result.headers?.Accept).toBe('application/json');
		expect(result.headers?.['Idempotency-Key']).toBeDefined();
	});
});

describe('cosendApiRequestAllItems', () => {
	const asLoad = (context: unknown) => context as unknown as ILoadOptionsFunctions;

	/**
	 * Catches: paginating with `?cursor=`.
	 *
	 * Doc 03 §5.6's draft used `cursor`; §4.6 corrects it to `after` against A2 §3.2, and the
	 * API's `parsePageRequest` reads `after` and `before` only. A `cursor` parameter is not
	 * rejected — it is *ignored*, so every request returns page one and the walk either loops or
	 * returns the first page's records over and over.
	 */
	it('walks pages with the after cursor, not cursor', async () => {
		let call = 0;
		const context = createContext({
			respond: () => {
				call += 1;
				return call === 1
					? { data: [{ id: 'a' }], has_more: true, next_cursor: 'cur_2' }
					: { data: [{ id: 'b' }], has_more: false, next_cursor: null };
			},
		});

		const all = await cosendApiRequestAllItems.call(asLoad(context), '/contacts');

		expect(all).toEqual([{ id: 'a' }, { id: 'b' }]);
		expect(context.requests).toHaveLength(2);
		expect(context.requests[0].qs).toEqual({ limit: MAX_PAGE_SIZE });
		expect(context.requests[1].qs).toEqual({ limit: MAX_PAGE_SIZE, after: 'cur_2' });
		expect(context.requests[1].qs).not.toHaveProperty('cursor');
	});

	// Catches: asking for more than the API will give. A2 §3.2 caps `limit` at 100 and the API
	// CLAMPS rather than rejecting, so a request for 200 looks like it worked and quietly returns
	// half of what the caller believes it asked for.
	it('never requests a page larger than the API maximum', async () => {
		const context = createContext({
			respond: () => ({ data: [], has_more: false, next_cursor: null }),
		});

		await cosendApiRequestAllItems.call(asLoad(context), '/contacts');

		expect(MAX_PAGE_SIZE).toBe(100);
		expect(context.requests[0].qs?.limit).toBeLessThanOrEqual(100);
	});

	/**
	 * Catches: a walk that trusts `has_more` alone.
	 *
	 * `has_more: true` with a null cursor is a contradiction the API should not produce, but a
	 * loop that only reads `has_more` re-requests page one forever when it does — an n8n execution
	 * that never returns and an API being hammered by it.
	 *
	 * The fake refuses to answer more than a handful of times rather than letting the loop run:
	 * without the cap the defect kills the worker with an out-of-memory crash, and "Worker exited
	 * unexpectedly" tells whoever hits it nothing about which rule was broken.
	 */
	it('stops when the cursor runs out even if has_more still says true', async () => {
		let calls = 0;
		const context = createContext({
			respond: () => {
				calls += 1;
				if (calls > 5) throw new Error('pagination did not terminate on a null cursor');
				return { data: [{ id: 'a' }], has_more: true, next_cursor: null };
			},
		});

		const all = await cosendApiRequestAllItems.call(asLoad(context), '/contacts');

		expect(all).toHaveLength(1);
		expect(context.requests).toHaveLength(1);
	});

	it('stops collecting once the requested limit is reached', async () => {
		const context = createContext({
			respond: () => ({
				data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
				has_more: true,
				next_cursor: 'cur_2',
			}),
		});

		const all = await cosendApiRequestAllItems.call(asLoad(context), '/contacts', {}, 2);

		expect(all).toHaveLength(2);
		expect(context.requests).toHaveLength(1);
	});

	it('carries the caller’s query parameters onto every page', async () => {
		let call = 0;
		const context = createContext({
			respond: () => {
				call += 1;
				return call === 1
					? { data: [], has_more: true, next_cursor: 'cur_2' }
					: { data: [], has_more: false, next_cursor: null };
			},
		});

		await cosendApiRequestAllItems.call(asLoad(context), '/conversations', { expand: 'contact' });

		expect(context.requests[0].qs?.expand).toBe('contact');
		expect(context.requests[1].qs?.expand).toBe('contact');
	});
});

describe('Return All on a declarative list operation', () => {
	/**
	 * Catches: Return All dropping every filter, and `limit`.
	 *
	 * Before each page n8n-core evaluates the pagination `request` against the operation's own
	 * request (`$request`) and the last response, then sends
	 * `{ ...requestData.options, ...paginateRequestData }` (routing-node.js, n8n-core 2.16.1): a
	 * shallow merge. A `request` of `{ qs: { after } }` replaced the whole query string, so Contacts
	 * Get Many with a tag and Return All on returned every contact.
	 */
	it('sends the operation’s query on every page, adding only the cursor', () => {
		const [returnAll] = paginationProperties({ resource: ['contact'], operation: ['getAll'] });
		const pagination = returnAll?.routing?.operations?.pagination;
		if (typeof pagination !== 'object' || pagination.type !== 'generic') {
			throw new Error('Return All should use generic pagination');
		}

		const expression = new Expression('UTC');
		const resolve = (value: unknown, data: IWorkflowDataProxyData): unknown => {
			if (typeof value === 'string') return expression.resolveSimpleParameterValue(value, data);
			if (typeof value !== 'object' || value === null) return value;
			return Object.fromEntries(
				Object.entries(value).map(([name, inner]) => [name, resolve(inner, data)]),
			);
		};
		const options: IHttpRequestOptions = {
			method: 'GET',
			url: '/contacts',
			qs: { tag: 'vip', limit: MAX_PAGE_SIZE },
		};
		// n8n's own keys for this evaluation: the operation's request and the last response.
		const pageAfter = (response: IDataObject): IHttpRequestOptions => {
			const keys = { $request: options, $response: response } as unknown as IWorkflowDataProxyData;
			return { ...options, ...(resolve(pagination.properties.request, keys) as IDataObject) };
		};

		expect(pageAfter({}).qs).toEqual({ tag: 'vip', limit: MAX_PAGE_SIZE });
		expect(pageAfter({ body: { has_more: true, next_cursor: 'cur_2' } }).qs).toEqual({
			tag: 'vip',
			limit: MAX_PAGE_SIZE,
			after: 'cur_2',
		});
	});
});

describe('Cosend error explanations', () => {
	it('reads the code, message and request id out of A2 §3.4’s envelope', () => {
		expect(
			cosendFailureOf({
				error: {
					type: 'invalid_request',
					code: 'service_window_closed',
					message: 'The 24-hour window is closed.',
					request_id: 'req_1',
				},
			}),
		).toEqual({
			code: 'service_window_closed',
			message: 'The 24-hour window is closed.',
			request_id: 'req_1',
		});
		// A body that is not the envelope — a proxy's error page, a network failure — has none.
		expect(cosendFailureOf('<html>Bad gateway</html>')).toEqual({});
		expect(cosendFailureOf(undefined)).toEqual({});
		expect(cosendFailureOf({ error: { code: 42 } })).toEqual({});
	});

	/**
	 * Catches: mapping codes the API never sends.
	 *
	 * Doc 03 §5.6 maps `outside_24h_window` and `number_not_registered`. Neither is in the API's
	 * error catalogue, so both branches are unreachable — dead code by standing rule 9, and a
	 * promise to the reader that the node explains an error it will never see (rule 10). The real
	 * codes are `service_window_closed` and `connection_not_active`.
	 */
	it('explains the codes the API actually sends, and no invented ones', () => {
		expect(explainCosendError('service_window_closed')).toMatch(/24 hours/);
		expect(explainCosendError('connection_not_active')).toMatch(/Connections/);
		expect(explainCosendError('recurring_schedules_not_available')).toMatch(/anchored/i);

		// The two Doc 03 invented. If either ever gains an explanation, the code behind it should
		// have been checked against the catalogue first.
		expect(explainCosendError('outside_24h_window')).toBeUndefined();
		expect(explainCosendError('number_not_registered')).toBeUndefined();
	});

	it('says nothing rather than guessing for an unknown code', () => {
		expect(explainCosendError('some_future_code')).toBeUndefined();
		expect(explainCosendError(undefined)).toBeUndefined();
	});
});
