import type {
	IDataObject,
	IExecuteSingleFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodeProperties,
	PostReceiveAction,
} from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { Cosend } from '../nodes/Cosend/Cosend.node';
import { outputProperties } from '../nodes/Cosend/shared/output';
import { CosendTrigger } from '../nodes/CosendTrigger/CosendTrigger.node';
import { simplifiedEvent } from '../nodes/CosendTrigger/simplify';
import { createContext, NODE } from './fakes';

/**
 * n8n's UX guidelines, "Simplifying output fields": a response of more than ten fields gets a
 * `Simplify` switch that returns at most ten, flat; the AI tool form gets `Output` with Simplified,
 * Raw and Selected Fields, and the selected fields always include the ID.
 */

const MESSAGE = {
	id: 'msg_01J9Z3K8M2Q4R6T8V0W2X4Y6Z8',
	object: 'message',
	conversation_id: 'cnv_01J9Z3K8M2Q4R6T8V0W2X4Y6Z8',
	contact_id: 'ct_01J9Z3K8M2Q4R6T8V0W2X4Y6Z8',
	contact: { phone_e164: '+919876543210', display_name: 'Priya' },
	connection_id: 'conn_01J9Z3K8M2Q4R6T8V0W2X4Y6Z8',
	wamid: 'wamid.x',
	direction: 'inbound',
	source: 'customer',
	status: 'delivered',
	type: 'text',
	content: { text: { body: 'Hello' } },
	reactions: [],
	metadata: {},
	created_at: '2026-11-07T10:00:00Z',
};

const ok = { statusCode: 200, body: {}, headers: {} } as IN8nHttpFullResponse;

/** The postReceive the Simplify and Output properties carry, as n8n's routing runs it. */
function shaper(): PostReceiveAction {
	const [simplify] = outputProperties({ resource: ['message'] }, 'message');
	const action = simplify?.routing?.output?.postReceive?.[0];
	if (typeof action !== 'function') throw new Error('Simplify has no postReceive function');
	return action;
}

async function shape(
	parameters: Record<string, unknown>,
	items: INodeExecutionData[],
	{ tool = false, response = ok } = {},
) {
	const context = {
		...createContext({ parameters: { resource: 'message', operation: 'get', ...parameters } }),
		getNode: () => ({ ...NODE, type: tool ? 'n8n-nodes-cosend.cosendTool' : 'n8n-nodes-cosend.cosend' }),
	};
	const action = shaper() as (
		this: IExecuteSingleFunctions,
		items: INodeExecutionData[],
		response: IN8nHttpFullResponse,
	) => Promise<INodeExecutionData[]>;
	return action.call(context as unknown as IExecuteSingleFunctions, items, response);
}

describe('Simplify', () => {
	it('returns at most ten flat fields, the ID first, when on', async () => {
		const [item] = await shape({ simplify: true }, [{ json: MESSAGE }]);

		const json = item?.json ?? {};
		expect(Object.keys(json).length).toBeLessThanOrEqual(10);
		expect(Object.keys(json)[0]).toBe('id');
		expect(json).toMatchObject({ id: MESSAGE.id, phone: '+919876543210', text: 'Hello' });
		for (const value of Object.values(json)) {
			expect(value === null || typeof value !== 'object' || Array.isArray(value)).toBe(true);
		}
	});

	it('returns the record as Cosend sent it when off', async () => {
		const items = [{ json: MESSAGE }];

		expect(await shape({ simplify: false }, items)).toBe(items);
	});

	// Catches: a refusal's code and request id flattened away by the simplified shape.
	it('leaves a refusal untouched', async () => {
		const items = [{ json: { error: 'No such message.', code: 'not_found' } }];
		const refused = { ...ok, statusCode: 404 };

		expect(await shape({ simplify: true }, items, { response: refused })).toBe(items);
	});
});

describe('Output, on the AI tool', () => {
	it('keeps the ID with the selected fields', async () => {
		const [item] = await shape({ output: 'selected', fields: ['status'] }, [{ json: MESSAGE }], {
			tool: true,
		});

		expect(item?.json).toEqual({ id: MESSAGE.id, status: 'delivered' });
	});

	it('returns every field when set to Raw', async () => {
		const items = [{ json: MESSAGE }];

		expect(await shape({ output: 'raw' }, items, { tool: true })).toBe(items);
	});

	it('simplifies by default', async () => {
		const [item] = await shape({}, [{ json: MESSAGE }], { tool: true });

		expect(Object.keys(item?.json ?? {}).length).toBeLessThanOrEqual(10);
	});
});

describe('the trigger’s Simplify from version 1.1', () => {
	it('gives the event and the same simplified message the action node returns', () => {
		const event = simplifiedEvent({
			id: 'evt_01J9Z3K8M2Q4R6T8V0W2X4Y6Z8',
			type: 'message.received',
			data: { object: MESSAGE },
		});

		expect(Object.keys(event).length).toBeLessThanOrEqual(10);
		expect(event).toMatchObject({ event: 'message.received', id: MESSAGE.id, text: 'Hello' });
	});

	it('keeps an unknown record to ten plain fields, its ID among them', () => {
		const wide: IDataObject = { id: 'x_1', object: 'something_new', nested: { a: 1 } };
		for (let i = 0; i < 20; i++) wide[`field_${i}`] = i;

		const event = simplifiedEvent({ type: 'something_new.created', data: { object: wide } });

		expect(Object.keys(event).length).toBeLessThanOrEqual(10);
		expect(event).toMatchObject({ event: 'something_new.created', id: 'x_1' });
		expect(event).not.toHaveProperty('nested');
	});
});

/**
 * Catches: an example ID the node's own check refuses. A Cosend ID is a prefix, an underscore and
 * a 26-character ULID, and a placeholder that is not one teaches the wrong shape.
 */
describe('example IDs', () => {
	const PREFIXES = ['aut', 'cnv', 'conn', 'ct', 'med', 'msg', 'note', 'run', 'usr'];
	const ID = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;
	const example = (placeholder: string) => placeholder.replace(/^e\.g\. /, '');

	/** Every object in the node's description that has a `placeholder`. */
	function withPlaceholder(value: unknown, found: IDataObject[] = []): IDataObject[] {
		if (Array.isArray(value)) {
			for (const entry of value) withPlaceholder(entry, found);
			return found;
		}
		if (typeof value !== 'object' || value === null) return found;
		if (typeof (value as IDataObject).placeholder === 'string') found.push(value as IDataObject);
		for (const entry of Object.values(value)) withPlaceholder(entry, found);
		return found;
	}

	const properties: INodeProperties[] = [
		...new Cosend().description.properties,
		...new CosendTrigger().description.properties,
	];
	const found = withPlaceholder(properties);
	const ids = found
		.map((entry) => example(String(entry.placeholder)))
		.filter((text) => PREFIXES.some((prefix) => text.startsWith(`${prefix}_`)));
	// A resource locator mode that checks its value with a regex, and the example it shows.
	const checked = found.flatMap((entry) => {
		const validation = (entry.validation as IDataObject[] | undefined)?.find(
			(rule) => rule.type === 'regex',
		);
		const regex = (validation?.properties as IDataObject | undefined)?.regex;
		return typeof regex === 'string' ? [[example(String(entry.placeholder)), regex] as const] : [];
	});

	it('finds the example IDs', () => {
		expect(ids.length).toBeGreaterThan(5);
		expect(checked.length).toBeGreaterThan(3);
	});

	it.each(ids)('%s is a valid Cosend ID', (text) => {
		expect(text).toMatch(ID);
	});

	it.each(checked)('%s passes its own field’s check, %s', (text, regex) => {
		expect(text).toMatch(new RegExp(regex));
	});
});
