import type {
	IDataObject,
	IExecuteFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { cosendApiRequest, failureItem, failureJsonOf, withItem } from '../shared/transport';
import { locatorValue, parseJson } from './messageBody';

/**
 * The two contract operations Upsert is built from. `test/contract.test.ts` checks both exist in
 * the generated contract and that the fields below are ones both of them accept — Upsert has no
 * `n8n:` marker of its own because it has no route of its own.
 */
export const UPSERT_USES = { create: 'contact.create', update: 'contact.update' } as const;

/** The paths, exported for the same test: a custom operation's paths live in code. */
export const UPSERT_CREATE_ENDPOINT = '/contacts';
export const UPSERT_UPDATE_ENDPOINT = (id: string) => `/contacts/${id}`;

/** `Additional Fields` → the API's field names. Both `createContactRequest` and `patchContactRequest` take all five. */
export const UPSERT_FIELDS: Record<string, string> = {
	attributes: 'attributes',
	locale: 'locale',
	profileName: 'profile_name',
	tags: 'tags',
	timezone: 'timezone',
};

/** The fields the user set under `Additional Fields`, in the API's names and shapes. */
function contactFields(context: IExecuteFunctions, itemIndex: number): IDataObject {
	const additional = context.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
	const fields: IDataObject = {};

	for (const [parameter, field] of Object.entries(UPSERT_FIELDS)) {
		const value = additional[parameter];
		if (value === undefined) continue;
		if (parameter === 'tags') {
			fields[field] = String(value)
				.split(',')
				.map((tag) => tag.trim())
				.filter((tag) => tag !== '');
			continue;
		}
		if (parameter === 'attributes') {
			const attributes = parseJson(context, 'Attributes', value, itemIndex);
			if (attributes !== undefined) fields[field] = attributes as IDataObject;
			continue;
		}
		fields[field] = value;
	}
	return fields;
}

/** The contact `POST /v1/contacts` answered with — an object with an id, or a loud failure. */
function contactIn(
	context: IExecuteFunctions,
	answer: IN8nHttpFullResponse,
	itemIndex: number,
): IDataObject & { id: string } {
	const body: unknown = answer.body;
	if (
		typeof body === 'object' &&
		body !== null &&
		typeof (body as { id?: unknown }).id === 'string'
	) {
		return body as IDataObject & { id: string };
	}
	throw new NodeOperationError(context.getNode(), 'Cosend answered without a contact', {
		itemIndex,
		description: `Creating the contact returned HTTP ${answer.statusCode} with no contact in it, so there is nothing to update.`,
	});
}

/**
 * `contact:upsert` — find the contact by phone number on this connection, then write the fields.
 *
 * cosend.app/n8n: "Upsert looks up by phone number and then writes, so a workflow does not need an
 * IF node in front of it." **`POST /v1/contacts` is the lookup.** A2 §5.6 makes it answer `200`
 * with the existing contact, unchanged, and `201` with a new one — and it settles the race between
 * two creates itself. So a new contact is written by the POST, and only an existing one needs the
 * second request, a `PATCH` with the same fields. A `GET` first would add a request and reopen the
 * race the POST already closes.
 */
export async function upsertContact(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];

	for (let i = 0; i < items.length; i++) {
		try {
			const fields = contactFields(this, i);
			// `returnFullResponse` makes the answer `{ statusCode, body }`; the body is checked below.
			const found = (await cosendApiRequest.call(
				this,
				'POST',
				UPSERT_CREATE_ENDPOINT,
				{
					connection_id: locatorValue(this, 'connectionId', i),
					phone_e164: this.getNodeParameter('phoneE164', i) as string,
					...fields,
				},
				{},
				{ returnFullResponse: true },
			)) as unknown as IN8nHttpFullResponse;
			const contact = contactIn(this, found, i);

			if (found.statusCode === 201 || Object.keys(fields).length === 0) {
				this.logger.info(
					found.statusCode === 201
						? 'Cosend upsert created a new contact'
						: 'Cosend upsert found the contact and had nothing to change',
					{ contactId: contact.id, itemIndex: i },
				);
				results.push({ json: contact, pairedItem: { item: i } });
				continue;
			}

			const updated = (await cosendApiRequest.call(
				this,
				'PATCH',
				UPSERT_UPDATE_ENDPOINT(contact.id),
				fields,
			)) as IDataObject;
			this.logger.info('Cosend upsert updated the existing contact', {
				contactId: contact.id,
				fields: Object.keys(fields).join(','),
				itemIndex: i,
			});
			results.push({ json: updated, pairedItem: { item: i } });
		} catch (error) {
			if (this.continueOnFail()) {
				results.push(failureItem(this.getNode(), failureJsonOf(error), i));
				continue;
			}
			// Both possible errors are already n8n's own classes, carrying the parameter or the
			// API's code; wrapping them again would bury the message that names the problem.
			throw withItem(this.getNode(), error, i);
		}
	}

	return [results];
}
