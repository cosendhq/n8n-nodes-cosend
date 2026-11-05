import type { IExecuteFunctions, INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { Cosend } from '../nodes/Cosend/Cosend.node';
import { CosendTrigger, OFFERED_EVENTS } from '../nodes/CosendTrigger/CosendTrigger.node';
import { buildMessageBody } from '../nodes/Cosend/operations/messageBody';
import { BATCH_ENDPOINT } from '../nodes/Cosend/operations/sendBatch';
import { SEND_ENDPOINT } from '../nodes/Cosend/operations/sendMessage';
import {
	UPSERT_CREATE_ENDPOINT,
	UPSERT_FIELDS,
	UPSERT_UPDATE_ENDPOINT,
	UPSERT_USES,
} from '../nodes/Cosend/operations/upsertContact';
import { attachIdempotencyKey, surfaceCosendError } from '../nodes/Cosend/shared/transport';
import { createExecuteContext } from './fakes';
import contract from './fixtures/contract.json';

/**
 * The drift test.
 *
 * `test/fixtures/contract.json` is **generated** by `scripts/sync-contract.mjs` from
 * `packages/contracts/generated` — the `n8n:` markers of A2 §10.2, each route's request and query
 * fields, and the closed event catalogue of A2 §7.2. Nothing in it is transcribed. This file
 * asserts the node and that fixture agree in both directions, which is standing rule 9 made
 * mechanical:
 *
 * - an operation the node offers with no route behind it is **a dropdown entry that cannot run**;
 * - a marked route no operation exposes is **a feature built and never switched on**;
 * - a field the node sends that the route does not declare is **a 400 on a `.strict()` schema**,
 *   and is what cosend.app/n8n means by "a field cannot be named one thing in n8n and another on
 *   the API".
 *
 * Regenerate with `pnpm contracts` then `pnpm sync-contract`, from inside a cosend-api checkout.
 */

const node = new Cosend().description;

/** `=/contacts/{{ $parameter.contactId }}` → `/contacts/{id}`, to compare with the fixture. */
const normalisePath = (url: string) => url.replace(/^=/, '').replace(/\{\{[^}]*\}\}/g, '{id}');

interface Routing {
	request?: {
		method?: string;
		url?: string;
		body?: Record<string, unknown>;
		qs?: Record<string, unknown>;
	};
	send?: {
		type?: string;
		property?: string;
		preSend?: unknown[];
	};
	operations?: { pagination?: unknown };
	output?: { postReceive?: unknown[] };
}

interface Declared {
	resource: string;
	operation: string;
	method?: string;
	path?: string;
	routing?: Routing;
}

type ContractOperation = (typeof contract.operations)[number];

/** Every operation the node declares, read out of the node description itself. */
function declaredOperations(): Declared[] {
	const declared: Declared[] = [];

	for (const property of node.properties) {
		if (property.name !== 'operation') continue;
		const resources = property.displayOptions?.show?.resource as string[] | undefined;
		expect(resources, 'every operation property is scoped to exactly one resource').toHaveLength(1);
		const resource = resources?.[0] as string;

		for (const option of (property.options ?? []) as INodePropertyOptions[]) {
			const routing = (option as { routing?: Routing }).routing;
			declared.push({
				resource,
				operation: String(option.value),
				...(routing?.request?.method === undefined ? {} : { method: routing.request.method }),
				...(routing?.request?.url === undefined
					? {}
					: { path: normalisePath(routing.request.url) }),
				...(routing === undefined ? {} : { routing }),
			});
		}
	}

	return declared;
}

const key = (entry: { resource: string; operation: string }) =>
	`${entry.resource}.${entry.operation}`;

const contractOperation = (name: string): ContractOperation | undefined =>
	contract.operations.find((entry) => key(entry) === name);

/**
 * Custom operations built from contract operations rather than having a route of their own.
 * Upsert is `POST /v1/contacts`, then `PATCH /v1/contacts/{id}` when the contact already existed.
 */
const COMPOSED: Record<string, readonly string[]> = {
	'contact.upsert': [UPSERT_USES.create, UPSERT_USES.update],
};

/** Whether a property is shown for this resource and operation. */
function shownFor(property: INodeProperties, resource: string, operation: string): boolean {
	const show = property.displayOptions?.show;
	if (show === undefined) return false;
	const resources = show.resource as string[] | undefined;
	const operations = show.operation as string[] | undefined;
	return (
		resources !== undefined &&
		resources.includes(resource) &&
		(operations === undefined || operations.includes(operation))
	);
}

interface Sent {
	name: string;
	type: string;
	field: string;
	/** A top-level parameter or the operation's own request: sent on every run. A collection's
	 *  option is sent only when the user adds it, and a pagination cursor only on page two. */
	always: boolean;
}

/**
 * Every field one declarative operation can send: what its own `routing.request` carries, the
 * routed properties shown for it, the options of its collections, and the cursor its pagination
 * adds. `template.name` sends `template`.
 */
function sentBy(operation: Declared): Sent[] {
	const sent: Sent[] = [];
	for (const [type, fixed] of [
		['body', operation.routing?.request?.body],
		['query', operation.routing?.request?.qs],
	] as const) {
		for (const field of Object.keys(fixed ?? {})) {
			sent.push({ name: `${operation.operation} request`, type, field, always: true });
		}
	}

	const visit = (property: INodeProperties, always: boolean) => {
		const send = (property as { routing?: Routing }).routing?.send;
		if (send?.property !== undefined && send.type !== undefined) {
			sent.push({
				name: property.name,
				type: send.type,
				field: send.property.split('.')[0] as string,
				always,
			});
		}
		// Return All's later pages send the operation's own query plus the cursor, `after`.
		if ((property as { routing?: Routing }).routing?.operations?.pagination !== undefined) {
			sent.push({ name: property.name, type: 'query', field: 'after', always: false });
		}
		if (property.type === 'collection') {
			for (const option of (property.options ?? []) as INodeProperties[]) visit(option, false);
		}
	};

	for (const property of node.properties) {
		if (shownFor(property, operation.resource, operation.operation)) visit(property, true);
	}
	return sent;
}

describe('the node and the published contract', () => {
	// Catches: an operation with no route. It would 404 the first time anyone ran it.
	it('offers no operation the API does not have', () => {
		const contractKeys = new Set(contract.operations.map(key));
		const extra = declaredOperations()
			.map(key)
			.filter((name) => !contractKeys.has(name))
			// A composed operation has no route of its own; every route it uses must exist.
			.filter((name) => !(COMPOSED[name] ?? ['-']).every((part) => contractKeys.has(part)));

		expect(extra, 'operations declared by the node with no matching n8n: marker').toEqual([]);
	});

	// Catches: a marked route nothing exposes — a built feature that is never switched on.
	it('exposes every route the contract marks for n8n', () => {
		const declared = new Set(declaredOperations().map(key));
		const missing = contract.operations.map(key).filter((name) => !declared.has(name));

		expect(missing, 'n8n: markers in the route table with no node operation').toEqual([]);
	});

	// Catches: a typo'd path or a wrong verb — a 404 or a 405 at run time, in the customer's
	// workflow rather than in this suite.
	it('routes every declarative operation at the method and path the contract gives it', () => {
		const expected = new Map(contract.operations.map((entry) => [key(entry), entry]));

		for (const operation of declaredOperations()) {
			// Custom operations' endpoints are asserted below, because a custom operation's path
			// lives in code and not in the description.
			if (operation.method === undefined) continue;

			const target = expected.get(key(operation));
			expect(target, `${key(operation)} is in the contract`).toBeDefined();
			expect(operation.method, `${key(operation)} method`).toBe(target?.method);
			expect(operation.path, `${key(operation)} path`).toBe(target?.path);
		}
	});

	it('points the custom operations at the contract paths', () => {
		expect(SEND_ENDPOINT).toBe(contractOperation('message.send')?.path);
		expect(BATCH_ENDPOINT).toBe(contractOperation('message.sendBatch')?.path);

		const create = contractOperation(UPSERT_USES.create);
		const update = contractOperation(UPSERT_USES.update);
		expect([create?.method, UPSERT_CREATE_ENDPOINT]).toEqual(['POST', create?.path]);
		expect([update?.method, UPSERT_UPDATE_ENDPOINT('{id}')]).toEqual(['PATCH', update?.path]);
	});

	// Catches: `customOperations` and the dropdown drifting apart. An operation with no routing
	// AND no custom implementation is a menu entry that does nothing at all.
	it('backs every operation with either routing or a custom implementation', () => {
		const custom = new Cosend().customOperations as Record<string, Record<string, unknown>>;

		for (const operation of declaredOperations()) {
			const hasRouting = operation.method !== undefined;
			const hasCustom = custom[operation.resource]?.[operation.operation] !== undefined;
			expect(
				hasRouting || hasCustom,
				`${key(operation)} has neither routing nor a custom implementation`,
			).toBe(true);
		}
	});

	// Catches: a custom implementation for an operation that is not in the menu — dead code.
	it('has no custom implementation without a matching operation', () => {
		const declared = new Set(declaredOperations().map(key));
		const custom = new Cosend().customOperations as Record<string, Record<string, unknown>>;

		for (const [resource, operations] of Object.entries(custom)) {
			for (const operation of Object.keys(operations)) {
				expect(
					declared.has(`${resource}.${operation}`),
					`${resource}.${operation} is offered`,
				).toBe(true);
			}
		}
	});
});

describe('the fields the node sends and the published contract', () => {
	const declarative = declaredOperations().filter((operation) => operation.method !== undefined);

	/**
	 * Catches: a field named one way in n8n and another on the API.
	 *
	 * cosend.app/n8n promises exactly this cannot happen. Every request schema here is
	 * `.strict()`, so a misnamed body field is a 400 on every run, and a misnamed query parameter
	 * is a filter that silently does nothing.
	 */
	it('sends only body and query fields the route declares', () => {
		const unknown: string[] = [];
		for (const operation of declarative) {
			const target = contractOperation(key(operation));
			const fields = {
				body: new Set(target?.body.map((field) => field.name)),
				query: new Set(target?.query.map((field) => field.name)),
			};
			for (const sent of sentBy(operation)) {
				const declared = sent.type === 'body' ? fields.body : fields.query;
				if (!declared.has(sent.field)) {
					unknown.push(`${key(operation)}: '${sent.name}' sends ${sent.type} '${sent.field}'`);
				}
			}
		}

		expect(unknown).toEqual([]);
	});

	// Catches: an operation that cannot succeed because it does not always send a field the route
	// requires — left in an optional collection, or not sent at all.
	it('always sends every body field the route requires', () => {
		const missing: string[] = [];
		for (const operation of declarative) {
			const sent = sentBy(operation);
			for (const field of contractOperation(key(operation))?.body ?? []) {
				if (!field.required) continue;
				const sender = sent.find((entry) => entry.type === 'body' && entry.field === field.name);
				if (sender?.always !== true) missing.push(`${key(operation)}: '${field.name}'`);
			}
		}

		expect(missing).toEqual([]);
	});

	/**
	 * Catches: an operation on a route that requires `Idempotency-Key` without the header.
	 *
	 * A2 §3.3: without it the API answers `400 idempotency_key_required` — every time. The custom
	 * operations set it themselves; a declarative one gets it from `attachIdempotencyKey`.
	 */
	it('sends Idempotency-Key on every declarative operation whose route requires it', () => {
		const without = declarative
			.filter((operation) => contractOperation(key(operation))?.idempotency === 'required')
			.filter(
				(operation) => !(operation.routing?.send?.preSend ?? []).includes(attachIdempotencyKey),
			)
			.map(key);

		expect(without, 'operations on an Idempotency-Key route that do not send one').toEqual([]);
	});

	it('writes only fields both of Upsert’s routes accept', () => {
		for (const part of Object.values(UPSERT_USES)) {
			const accepted = new Set(contractOperation(part)?.body.map((field) => field.name));
			for (const field of Object.values(UPSERT_FIELDS)) {
				expect(accepted.has(field), `${part} accepts '${field}'`).toBe(true);
			}
		}
	});

	/**
	 * Catches: the Send body drifting from `sendMessageRequest`. Send is a custom operation, so
	 * its fields are built in code — this builds one body per message type, with every option set,
	 * and holds its keys to the route's.
	 */
	it('builds Send bodies from fields the route declares', async () => {
		const accepted = new Set(contractOperation('message.send')?.body.map((field) => field.name));
		const options = {
			replyTo: 'wamid.example',
			source: 'api',
			sendMode: 'auto',
			fallbackTemplateName: 'appointment_reminder',
			fallbackTemplateLanguage: 'en_US',
			metadata: '{"order":"4821"}',
		};
		const common = { connectionId: { value: 'conn_x' }, contactId: { value: '+919876543210' } };
		const types: Record<string, Record<string, unknown>> = {
			text: { text: 'Hello', previewUrl: true },
			image: { mediaSource: 'url', mediaUrl: 'https://example.com/a.png', caption: 'A' },
			document: { mediaSource: 'id', mediaId: 'med_x', caption: 'A', filename: 'a.pdf' },
			template: { templateName: { value: 'hello' }, templateLanguage: 'en_US' },
			location: { location: '{"latitude":1,"longitude":2}' },
			contacts: { contacts: '[]' },
			interactive: { interactive: '{}' },
		};

		for (const [messageType, parameters] of Object.entries(types)) {
			for (const sendTo of ['contact', 'conversation']) {
				const context = createExecuteContext({
					items: [
						{
							...common,
							...parameters,
							conversationId: { value: 'cnv_x' },
							messageType,
							sendTo,
							options,
						},
					],
				});
				const body = await buildMessageBody(context as unknown as IExecuteFunctions, 0);
				for (const field of Object.keys(body)) {
					expect(accepted.has(field), `${messageType} to a ${sendTo} sends '${field}'`).toBe(true);
				}
			}
		}
	});

	/**
	 * Catches: a refusal coming out of a declarative operation looking like data.
	 *
	 * `ignoreHttpStatusErrors` lets the API's error body through as a response, and only
	 * `surfaceCosendError` turns it back into an error. The two are only safe together, and the
	 * check has to run before any operation's `rootProperty` unwraps the body.
	 */
	it('checks every declarative answer for a refusal before anything else reads it', () => {
		expect(node.requestDefaults?.ignoreHttpStatusErrors).toBe(true);
		const resource = node.properties[0] as INodeProperties & { routing?: Routing };
		expect(resource.name).toBe('resource');
		expect(resource.routing?.output?.postReceive?.[0]).toBe(surfaceCosendError);
	});
});

describe('the trigger and the published event catalogue', () => {
	// Catches: a typo'd or renamed event name. `POST /v1/webhook-endpoints` validates `events`
	// against a closed enum, so a stale name is a 400 on activation — not a quiet no-op.
	it('offers only events the API will accept a subscription to', () => {
		const catalogue = new Set(contract.events);
		const unknown = OFFERED_EVENTS.filter((event) => !catalogue.has(event));

		expect(unknown, 'trigger events that are not in A2 §7.2s catalogue').toEqual([]);
	});

	/**
	 * **The one that catches an event nothing emits.**
	 *
	 * Catalogue membership is not enough, and this test exists because the weaker version of it
	 * passed while the trigger offered `automation.run_finished` — a name the API happily accepts
	 * a subscription to and that no code path in cosend-api produced at the time. The user would
	 * have got a green activation and a workflow that never runs, which is worse than an error.
	 *
	 * Asserted as an exact set equality rather than a subset, so a new catalogue event has to be
	 * classified deliberately: gaining a producer makes this fail until it is offered, and being
	 * offered without one makes it fail immediately.
	 */
	it('offers exactly the events that have a producer, less the test-only ping', () => {
		const shouldOffer = contract.eventsWithProducers.filter((event) => event !== 'ping');

		expect([...OFFERED_EVENTS].sort()).toEqual([...shouldOffer].sort());
	});

	it('offers none of the events that nothing emits yet', () => {
		const dead = OFFERED_EVENTS.filter((event) =>
			(contract.eventsWithoutProducers as string[]).includes(event),
		);

		expect(dead, 'trigger events in the catalogue that no code path emits').toEqual([]);
	});

	/**
	 * cosend.app/n8n and /docs/n8n/trigger name these, and the two in the middle are the reason
	 * to install the node at all. Losing one would break the page's promise even while the
	 * producer test above stayed green, if its producer went away.
	 */
	it('offers every event the n8n pages name', () => {
		for (const event of [
			'message.received',
			'message.status',
			'message.echo',
			'conversation.created',
			'conversation.updated',
			'conversation.window_expiring',
			'contact.consent_changed',
			'automation.run_finished',
			'automation.run_failed',
			'connection.disconnected',
			'connection.needs_reauth',
			'usage.threshold_reached',
		]) {
			expect(OFFERED_EVENTS, event).toContain(event);
		}
	});

	/**
	 * `ping` is in the catalogue and must NOT be in the dropdown: A2 §7.2 marks it "Test only" and
	 * its sole emitter is `POST /v1/webhook-endpoints/{id}/test`. `webhook()` answers it without
	 * starting a workflow, so subscribing to it in the UI would promise something the node then
	 * deliberately refuses to do.
	 */
	it('does not offer the test-only ping event', () => {
		expect(contract.events).toContain('ping');
		expect(OFFERED_EVENTS).not.toContain('ping');
	});

	it('offers a non-empty, duplicate-free event list', () => {
		expect(OFFERED_EVENTS.length).toBeGreaterThan(0);
		expect(new Set(OFFERED_EVENTS).size).toBe(OFFERED_EVENTS.length);
	});

	it('defaults to an event it actually offers', () => {
		const events = new CosendTrigger().description.properties.find(
			(property: INodeProperties) => property.name === 'events',
		);
		for (const value of (events?.default ?? []) as string[]) {
			expect(OFFERED_EVENTS).toContain(value);
		}
	});
});
