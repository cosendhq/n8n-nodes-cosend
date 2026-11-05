import type { IHookFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { CosendTrigger } from '../nodes/CosendTrigger/CosendTrigger.node';
import { createContext, httpError, type FakeContext, type RecordedRequest } from './fakes';

const methods = new CosendTrigger().webhookMethods.default;
const asHook = (context: FakeContext) => context as unknown as IHookFunctions;

const PUBLIC_URL = 'https://n8n.example.com/webhook/abc123/webhook';
const ENDPOINT_ID = 'whe_01H8XK3M9PQRSTUVWXYZ01';

const listing = (endpoints: unknown[]) => ({
	data: endpoints,
	has_more: false,
	next_cursor: null,
});

const CREDENTIAL_ID = 'key_01H8XK3M9PQRSTUVWXYZ01';
const ME_URL = 'https://api.cosend.app/v1/me';
const ENDPOINTS_URL = 'https://api.cosend.app/v1/webhook-endpoints';

/** `GET /v1/me` as Cosend answers it for an API key, and everything else with `rest`. */
const api =
	(rest: (request: RecordedRequest) => unknown) =>
	(request: RecordedRequest): unknown =>
		request.url === ME_URL
			? { credential: { kind: 'organization', id: CREDENTIAL_ID, name: 'n8n', is_live: true } }
			: rest(request);

/**
 * An endpoint as `GET /v1/webhook-endpoints` lists it: every filter member, `[]` where there is
 * none. These are what the node registers with its defaults: its own key's sends left out, and
 * conversation events carrying the contact.
 */
const registered = (overrides: Record<string, unknown> = {}) => ({
	id: ENDPOINT_ID,
	url: PUBLIC_URL,
	events: ['message.received'],
	connection_id: null,
	filters: {
		message_types: [],
		message_statuses: [],
		labels: [],
		assignee_ids: [],
		automation_ids: [],
		exclude_sent_by_api_key_ids: [CREDENTIAL_ID],
	},
	include_contact: true,
	...overrides,
});

describe('CosendTrigger create', () => {
	/**
	 * Catches: filtering in the node instead of on Cosend's server.
	 *
	 * cosend.app/docs/n8n/trigger promises the filters run server-side: an event a filter leaves
	 * out is never delivered and starts nothing. That holds only if the endpoint is created with
	 * them, and with this credential's key id for Ignore Messages Sent by Me.
	 */
	it('creates the endpoint with the filters and include_contact', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			parameters: {
				events: ['message.received', 'conversation.updated'],
				connectionId: '',
				filters: {
					messageTypes: ['text', 'image'],
					statuses: ['read'],
					labels: ' vip, urgent,,vip',
					assigneeIds: 'usr_01H8XK3M9PQRSTUVWXYZ01',
					automationIds: 'aut_01H8XK3M9PQRSTUVWXYZ01',
				},
			},
			respond: api(() => ({ id: ENDPOINT_ID, secret: 'whsec_live_abc' })),
		});

		await methods.create.call(asHook(context));

		expect(context.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			`GET ${ME_URL}`,
			`POST ${ENDPOINTS_URL}`,
		]);
		expect(context.requests[1].body).toEqual({
			url: PUBLIC_URL,
			events: ['message.received', 'conversation.updated'],
			filters: {
				message_types: ['text', 'image'],
				message_statuses: ['read'],
				labels: ['vip', 'urgent'],
				assignee_ids: ['usr_01H8XK3M9PQRSTUVWXYZ01'],
				automation_ids: ['aut_01H8XK3M9PQRSTUVWXYZ01'],
				exclude_sent_by_api_key_ids: [CREDENTIAL_ID],
			},
			include_contact: true,
		});
	});

	it('sends no filter and include_contact false when both are switched off', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			parameters: {
				events: ['message.received'],
				connectionId: '',
				ignoreSentByMe: false,
				options: { includeContact: false },
			},
			respond: () => ({ id: ENDPOINT_ID, secret: 'whsec_live_abc' }),
		});

		await methods.create.call(asHook(context));

		// No `GET /v1/me`: the key id is only needed to leave its own sends out.
		expect(context.requests).toHaveLength(1);
		expect(context.requests[0].body).toEqual({
			url: PUBLIC_URL,
			events: ['message.received'],
			filters: {},
			include_contact: false,
		});
	});

	it('includes connection_id only when one is chosen', async () => {
		const withConnection = createContext({
			webhookUrl: PUBLIC_URL,
			parameters: { events: ['message.received'], connectionId: 'conn_01H8XK3M9PQRSTUVWXYZ01' },
			respond: api(() => ({ id: ENDPOINT_ID, secret: 'whsec_live_abc' })),
		});
		await methods.create.call(asHook(withConnection));
		expect(Object.keys(withConnection.requests[1].body as object).sort()).toEqual([
			'connection_id',
			'events',
			'filters',
			'include_contact',
			'url',
		]);
	});

	// Catches: registering "ignore my own sends" with no key in it, which ignores nothing.
	it('refuses to activate when Cosend does not say which key the credential holds', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			parameters: { events: ['message.sent'], connectionId: '' },
			respond: () => ({}),
		});

		await expect(methods.create.call(asHook(context))).rejects.toThrow(
			'Could not tell which Cosend API key this credential holds',
		);
		expect(context.requests.map((request) => request.url)).toEqual([ME_URL]);
	});

	// Catches: losing the signing secret. A2 §5.16 returns it exactly once, so a `create` that
	// stores the id but not the secret leaves a trigger that rejects every delivery it receives
	// and can only be repaired by deleting the endpoint.
	it('stores both the endpoint id and the one-time signing secret', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			parameters: { events: ['message.received'], connectionId: '' },
			respond: api(() => ({ id: ENDPOINT_ID, secret: 'whsec_live_abc' })),
		});

		await methods.create.call(asHook(context));

		expect(context.staticData.webhookId).toBe(ENDPOINT_ID);
		expect(context.staticData.webhookSecret).toBe('whsec_live_abc');
	});

	// Catches: registering an endpoint Cosend can never deliver to. Without this the user gets a
	// green activation and silence, which is the worst possible failure for a trigger.
	it('refuses a webhook URL that is not publicly reachable', async () => {
		for (const url of [
			'http://localhost:5678/webhook/abc/webhook',
			'http://127.0.0.1:5678/w',
			undefined,
		]) {
			const context = createContext({
				webhookUrl: url,
				parameters: { events: ['message.received'], connectionId: '' },
			});
			await expect(methods.create.call(asHook(context))).rejects.toThrow(/not public/i);
			expect(context.requests).toHaveLength(0);
		}
	});
});

describe('CosendTrigger checkExists', () => {
	it('returns false without calling the API when nothing was registered', async () => {
		const context = createContext({ parameters: { events: ['message.received'] } });
		expect(await methods.checkExists.call(asHook(context))).toBe(false);
		expect(context.requests).toHaveLength(0);
	});

	/**
	 * Catches: fetching the endpoint by id.
	 *
	 * A2 §5.16 gives the collection a GET and the item a PATCH and a DELETE — **there is no
	 * `GET /v1/webhook-endpoints/{id}`**. Doc 03 §4.4 says to use one; that request 404s, which
	 * this node would read as "the endpoint is gone" and re-register on every activation, leaking
	 * a new endpoint each time.
	 */
	it('finds the endpoint through the list, not through an item GET', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			parameters: { events: ['message.received'], connectionId: '' },
			respond: api(() => listing([registered()])),
		});

		expect(await methods.checkExists.call(asHook(context))).toBe(true);
		// The list, then `/me` for the key id the filters compare against: no item GET.
		expect(context.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			`GET ${ENDPOINTS_URL}`,
			`GET ${ME_URL}`,
		]);
	});

	/**
	 * Catches: an endpoint left filtering on the old values.
	 *
	 * The filters run on Cosend's server, so a filter changed in the node does nothing until the
	 * endpoint carries it. An endpoint whose filters drifted is replaced the way drifted events are.
	 */
	it('replaces the endpoint when the filters changed', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			parameters: { events: ['message.received'], connectionId: '', filters: { labels: 'vip' } },
			respond: api(() => listing([registered()])),
		});

		expect(await methods.checkExists.call(asHook(context))).toBe(false);
		expect(context.staticData.staleWebhookId).toBe(ENDPOINT_ID);
		expect(context.staticData.webhookId).toBeUndefined();
		expect(context.logs[0]).toMatchObject({
			level: 'info',
			meta: { endpointId: ENDPOINT_ID, filtersChanged: true, eventsChanged: false },
		});
	});

	it('replaces the endpoint when Ignore Messages Sent by Me was switched off', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			parameters: { events: ['message.received'], connectionId: '', ignoreSentByMe: false },
			respond: api(() => listing([registered()])),
		});

		expect(await methods.checkExists.call(asHook(context))).toBe(false);
		expect(context.staticData.staleWebhookId).toBe(ENDPOINT_ID);
	});

	it('replaces the endpoint when Include Contact changed', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			parameters: {
				events: ['message.received'],
				connectionId: '',
				options: { includeContact: false },
			},
			respond: api(() => listing([registered()])),
		});

		expect(await methods.checkExists.call(asHook(context))).toBe(false);
		expect(context.logs[0]).toMatchObject({
			meta: { includeContactChanged: true, filtersChanged: false },
		});
	});

	it('keeps the endpoint when the same filters come back in another order', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			parameters: {
				events: ['message.received'],
				connectionId: '',
				filters: { messageTypes: ['text', 'image'] },
			},
			respond: api(() =>
				listing([
					registered({
						filters: {
							...registered().filters,
							message_types: ['image', 'text'],
						},
					}),
				]),
			),
		});

		expect(await methods.checkExists.call(asHook(context))).toBe(true);
	});

	// Catches: comparing ids only. n8n hands out a new webhook URL when a workflow is renamed or
	// moved; an endpoint still pointing at the old one delivers into nothing, forever.
	it('rebuilds when the registered URL no longer matches this node', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			parameters: { events: ['message.received'], connectionId: '' },
			respond: api(() =>
				listing([registered({ url: 'https://n8n.example.com/webhook/OLD/webhook' })]),
			),
		});

		expect(await methods.checkExists.call(asHook(context))).toBe(false);
		expect(context.staticData.webhookId).toBeUndefined();
		// The secret goes with the id: a new endpoint mints a new one, and keeping the old value
		// would make every delivery fail the signature check.
		expect(context.staticData.webhookSecret).toBeUndefined();
	});

	it('rebuilds when the subscribed events drifted from the node parameters', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			parameters: { events: ['message.received', 'message.status'], connectionId: '' },
			respond: api(() => listing([registered()])),
		});

		expect(await methods.checkExists.call(asHook(context))).toBe(false);
		expect(context.staticData.webhookId).toBeUndefined();
	});

	it('rebuilds when the connection filter drifted', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			parameters: { events: ['message.received'], connectionId: 'conn_01H8XK3M9PQRSTUVWXYZ01' },
			respond: api(() => listing([registered()])),
		});

		expect(await methods.checkExists.call(asHook(context))).toBe(false);
	});

	/**
	 * Catches: deleting the old endpoint before its replacement exists.
	 *
	 * Deleted here, a `create` refused a moment later (a key without `webhooks:write`, a URL that
	 * stopped being public) would leave the workflow with no subscription at all, where before it
	 * still had the old one. So `checkExists` only marks it; `create` removes it once the new one is
	 * registered.
	 */
	it('marks a drifted endpoint for replacement without deleting it yet', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			parameters: { events: ['message.received', 'message.status'], connectionId: '' },
			respond: api(() => listing([registered()])),
		});

		expect(await methods.checkExists.call(asHook(context))).toBe(false);
		// The list and `/me`; no DELETE.
		expect(context.requests.map((request) => request.method)).toEqual(['GET', 'GET']);
		expect(context.staticData.staleWebhookId).toBe(ENDPOINT_ID);
		expect(context.logs[0]).toMatchObject({
			level: 'info',
			meta: { endpointId: ENDPOINT_ID, eventsChanged: true, urlChanged: false },
		});
	});

	it('marks nothing when the endpoint is simply gone', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			parameters: { events: ['message.received'], connectionId: '' },
			respond: () => listing([]),
		});

		expect(await methods.checkExists.call(asHook(context))).toBe(false);
		expect(context.staticData.staleWebhookId).toBeUndefined();
	});

	/**
	 * Catches: `catch { return false }`.
	 *
	 * That is the `no-silent-error-swallowing` rule in product terms. An expired credential or a
	 * network blip would be read as "the endpoint is gone", and n8n would call `create` — so every
	 * activation while the credential is broken leaks another endpoint, and when the credential is
	 * fixed the customer has a pile of duplicates all delivering the same events.
	 */
	it('rethrows a server error instead of treating it as a missing endpoint', async () => {
		const context = createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			parameters: { events: ['message.received'], connectionId: '' },
			respond: () => {
				throw httpError(500, 'internal_error', 'Something broke.');
			},
		});

		await expect(methods.checkExists.call(asHook(context))).rejects.toThrow(
			'Could not check the Cosend webhook subscription',
		);
		// The registration must survive: forgetting it here is what causes the duplicate.
		expect(context.staticData.webhookId).toBe(ENDPOINT_ID);
	});
});

describe('CosendTrigger replacing a drifted endpoint', () => {
	const NEW_ID = 'whe_01K3F8XK3M9PQRSTVWXYZ01ABC';

	const replacing = (onDelete: (request: RecordedRequest) => unknown) =>
		createContext({
			webhookUrl: PUBLIC_URL,
			staticData: { staleWebhookId: ENDPOINT_ID },
			// Off, so the requests here are the replacement's alone; `/me` is tested above.
			parameters: { events: ['message.status'], connectionId: '', ignoreSentByMe: false },
			respond: (request) =>
				request.method === 'POST' ? { id: NEW_ID, secret: 'whsec_live_new' } : onDelete(request),
		});

	/**
	 * Catches: replacing by forgetting.
	 *
	 * cosend.app/docs/n8n/trigger: an endpoint whose URL or events no longer match "is replaced
	 * rather than left pointing somewhere stale". Registering a new one and forgetting the old
	 * leaves the old one delivering to the old URL — or the old event set — for ever.
	 */
	it('registers the new endpoint first, then deletes the old one', async () => {
		const context = replacing(() => ({ id: ENDPOINT_ID, deleted: true }));

		expect(await methods.create.call(asHook(context))).toBe(true);
		expect(context.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			'POST https://api.cosend.app/v1/webhook-endpoints',
			`DELETE https://api.cosend.app/v1/webhook-endpoints/${ENDPOINT_ID}`,
		]);
		expect(context.staticData).toEqual({ webhookId: NEW_ID, webhookSecret: 'whsec_live_new' });
		expect(context.logs[context.logs.length - 1]).toMatchObject({
			meta: { removedEndpointId: ENDPOINT_ID, endpointId: NEW_ID },
		});
	});

	it('treats the old endpoint already being gone as replaced', async () => {
		const context = replacing(() => {
			throw httpError(404);
		});

		expect(await methods.create.call(asHook(context))).toBe(true);
		expect(context.staticData.staleWebhookId).toBeUndefined();
	});

	/**
	 * Catches: a failed activation leaving a live endpoint behind.
	 *
	 * n8n keeps no static data from a `create` that throws, so the new endpoint's id goes with it:
	 * an endpoint delivering to this workflow that nothing knows how to remove. Removing it leaves
	 * Cosend as it was, with the old endpoint still there for the next activation to replace.
	 */
	it('removes the new endpoint and says so when the old one cannot be deleted', async () => {
		const context = replacing((request) => {
			if (request.url.endsWith(ENDPOINT_ID)) {
				throw httpError(500, 'internal_error', 'Something broke.');
			}
			return { id: NEW_ID, deleted: true };
		});

		await expect(methods.create.call(asHook(context))).rejects.toThrow(
			'Could not remove the old Cosend webhook subscription',
		);
		expect(context.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			'POST https://api.cosend.app/v1/webhook-endpoints',
			`DELETE https://api.cosend.app/v1/webhook-endpoints/${ENDPOINT_ID}`,
			`DELETE https://api.cosend.app/v1/webhook-endpoints/${NEW_ID}`,
		]);
		expect(context.logs[context.logs.length - 1]).toMatchObject({
			level: 'warn',
			meta: { endpointId: NEW_ID, staleEndpointId: ENDPOINT_ID },
		});
		// Nothing points at the endpoint that was just removed, whatever n8n does with static data.
		expect(context.staticData.webhookId).toBeUndefined();
		expect(context.staticData.webhookSecret).toBeUndefined();
	});

	// Catches: a failed clean-up hiding why the activation failed, or the second subscription it left.
	it('still names the old endpoint’s failure when the new one cannot be removed either', async () => {
		const context = replacing(() => {
			throw httpError(500, 'internal_error', 'Something broke.');
		});

		const failure = (await methods.create
			.call(asHook(context))
			.catch((error: unknown) => error)) as Error & { description?: string };

		expect(failure.message).toBe('Could not remove the old Cosend webhook subscription');
		expect(failure.description).toMatch(/two subscriptions/);
		expect(context.logs[context.logs.length - 1]).toMatchObject({
			level: 'error',
			meta: { endpointId: NEW_ID, staleEndpointId: ENDPOINT_ID },
		});
	});
});

describe('CosendTrigger delete', () => {
	it('deletes the registered endpoint and forgets it', async () => {
		const context = createContext({
			staticData: { webhookId: ENDPOINT_ID, webhookSecret: 'whsec_live_abc' },
			respond: () => ({ deleted: true }),
		});

		expect(await methods.delete.call(asHook(context))).toBe(true);
		expect(context.requests[0].method).toBe('DELETE');
		expect(context.requests[0].url).toBe(
			`https://api.cosend.app/v1/webhook-endpoints/${ENDPOINT_ID}`,
		);
		expect(context.staticData.webhookId).toBeUndefined();
		expect(context.staticData.webhookSecret).toBeUndefined();
	});

	// Already gone is the state we wanted. Failing here would leave the workflow undeletable.
	it('treats a 404 as success', async () => {
		const context = createContext({
			staticData: { webhookId: ENDPOINT_ID },
			respond: () => {
				throw httpError(404);
			},
		});

		expect(await methods.delete.call(asHook(context))).toBe(true);
		expect(context.staticData.webhookId).toBeUndefined();
	});

	/**
	 * Catches: swallowing every error, not just the 404.
	 *
	 * If the DELETE really failed and the node forgets the id anyway, the endpoint survives in
	 * Cosend with nothing left that knows how to remove it — an orphan posting to a dead n8n URL
	 * until the auto-disable counter kills it a hundred failures later.
	 */
	it('rethrows any failure that is not a 404, and keeps the id', async () => {
		const context = createContext({
			staticData: { webhookId: ENDPOINT_ID },
			respond: () => {
				throw httpError(500, 'internal_error', 'Something broke.');
			},
		});

		await expect(methods.delete.call(asHook(context))).rejects.toThrow(
			'Could not remove the Cosend webhook subscription',
		);
		expect(context.staticData.webhookId).toBe(ENDPOINT_ID);
	});
});
