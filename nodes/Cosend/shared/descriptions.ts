import type {
	IDataObject,
	IExecuteSingleFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { attachIdempotencyKey, MAX_PAGE_SIZE } from './transport';

type Show = Record<string, string[]>;

/**
 * Each page's query: the operation's own, plus the cursor.
 *
 * n8n-core builds each page's request as `{ ...requestData.options, ...paginateRequestData }`, a
 * shallow merge, so a `request` of `{ qs: { after } }` replaces the whole query string, every
 * filter and `limit` with it, from page one on. `$request` is the operation's own request,
 * unchanged between pages. n8n types `qs` as an object; at run time an expression in its place is
 * evaluated like any other, to the object it returns.
 */
const QUERY_WITH_CURSOR =
	'={{ Object.assign({}, $request.qs, { after: $response.body?.next_cursor }) }}' as unknown as IDataObject;

/**
 * `Return All` + `Limit`, wired to A2 §3.2's cursor pagination.
 *
 * **`after`, and `has_more`** — not `cursor`, and not "stop when `next_cursor` is null". The API's
 * `parsePageRequest` reads `after` and `before` only; a `cursor` query parameter is accepted by
 * Fastify, ignored by the handler, and returns page one again. A pagination loop written against
 * it terminates only because `has_more` eventually reads false — after re-fetching the first page
 * forever. Doc 03 §5.7's draft had exactly this shape; §4.6 is the corrected version.
 */
export const paginationProperties = (show: Show): INodeProperties[] => [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: { show },
		routing: {
			send: {
				paginate: '={{ $value }}',
				type: 'query',
				property: 'limit',
				value: String(MAX_PAGE_SIZE),
			},
			operations: {
				pagination: {
					type: 'generic',
					properties: {
						continue: '={{ $response.body?.has_more === true }}',
						request: { qs: QUERY_WITH_CURSOR },
					},
				},
			},
		},
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		// 50 is n8n's convention for a Limit spinner (`node-param-default-wrong-for-limit`), not
		// A2 §3.2's server-side default of 25 — the node always sends the value explicitly, so the
		// two can never disagree about what was asked for.
		default: 50,
		// A2 §3.2 caps `limit` at 100. The API CLAMPS a larger value rather than rejecting it, so a
		// spinner that allowed 200 would silently return 100 and look like a Cosend bug.
		typeOptions: { minValue: 1, maxValue: MAX_PAGE_SIZE },
		description: 'Max number of results to return',
		displayOptions: { show: { ...show, returnAll: [false] } },
		routing: {
			send: { type: 'query', property: 'limit' },
			output: { maxResults: '={{$value}}' },
		},
	},
];

/**
 * A2 §3.2 wraps every list in `{ data, has_more, next_cursor }`. n8n's rule is to emit one item
 * per record, so every list operation unwraps `data`.
 *
 * **A function rather than n8n's `rootProperty`, because of what a refusal leaves behind.** n8n
 * runs every `postReceive` in turn, so under "On Error → Continue" the item `surfaceCosendError`
 * made from a refusal comes here next — and `rootProperty: data` would turn it into one item with
 * no JSON, losing the `code` and `request_id` it carries.
 */
async function unwrapList(
	this: IExecuteSingleFunctions,
	items: INodeExecutionData[],
	response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	if (response.statusCode >= 400) return items;
	return items.flatMap((item) => {
		const data = item.json.data;
		return Array.isArray(data) ? data.map((record) => ({ json: record as IDataObject })) : [];
	});
}

export const unwrapData = {
	output: { postReceive: [unwrapList] },
};

/** A2 §3.3's required header, minted per request. See `attachIdempotencyKey`. */
export const sendWithIdempotencyKey = {
	send: { preSend: [attachIdempotencyKey] },
};

/**
 * The `Idempotency Key` entry for an `Options` collection.
 *
 * Left blank the node mints a UUID per request, which is the safe default. A caller who wants a
 * *retry* to be recognised as the same send supplies a stable key of their own — that is the only
 * way an n8n retry stops being a second WhatsApp message.
 */
export const idempotencyKeyOption: INodeProperties = {
	displayName: 'Idempotency Key',
	name: 'idempotencyKey',
	type: 'string',
	default: '',
	description:
		'A key that makes this request safe to retry. Leave empty and Cosend generates one per request. Set your own — an order ID, say — and a repeated request returns the first result instead of sending again.',
};

/**
 * The contact a path parameter names.
 *
 * A phone number is a legitimate mode here and not a convenience the node invented: the API's
 * `findContact` resolves the `{id}` segment as an ID, an E.164 number **or** a BSUID for get,
 * update and delete alike, and `GET /v1/contacts/{id}` documents itself as "by id, E.164 or
 * BSUID". Offering only IDs would hide a capability the contract has.
 */
export const contactLocator = (description: string): INodeProperties => ({
	displayName: 'Contact',
	name: 'contactId',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description,
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchContacts', searchable: true },
		},
		{
			displayName: 'Phone Number',
			name: 'phone',
			type: 'string',
			placeholder: 'e.g. +919876543210',
			validation: [
				{
					type: 'regex',
					properties: {
						regex: '^\\+[1-9]\\d{6,14}$',
						errorMessage: "Enter the number in E.164 format, for example '+919876543210'",
					},
				},
			],
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. ct_01H8XK3M9PQRSTUVWXYZ01',
			validation: [
				{
					type: 'regex',
					properties: {
						regex: '^ct_[0-9A-HJKMNP-TV-Z]{26}$',
						errorMessage: "A contact ID looks like 'ct_' followed by 26 characters",
					},
				},
			],
		},
	],
});

/** The conversation a path parameter names. */
export const conversationLocator = (description: string): INodeProperties => ({
	displayName: 'Conversation',
	name: 'conversationId',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description,
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchConversations', searchable: true },
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. cnv_01H8XK3M9PQRSTUVWXYZ01',
			validation: [
				{
					type: 'regex',
					properties: {
						regex: '^cnv_[0-9A-HJKMNP-TV-Z]{26}$',
						errorMessage: "A conversation ID looks like 'cnv_' followed by 26 characters",
					},
				},
			],
		},
	],
});

/**
 * The WhatsApp connection to act on.
 *
 * Optional wherever the API allows it, because a **connection key** already names one — A2 §5.4:
 * "Optional with a connection key". Required only where the request schema makes it required:
 * `POST /v1/contacts`, `POST /v1/media`, `POST /v1/notifications` and `POST /v1/schedules` all
 * declare `connection_id` non-optional.
 */
export const connectionLocator = (options: {
	required: boolean;
	description: string;
}): INodeProperties => ({
	displayName: 'Connection',
	name: 'connectionId',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: options.required,
	description: options.description,
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchConnections', searchable: true },
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. conn_01H8XK3M9PQRSTUVWXYZ01',
			validation: [
				{
					type: 'regex',
					properties: {
						regex: '^conn_[0-9A-HJKMNP-TV-Z]{26}$',
						errorMessage: "A connection ID looks like 'conn_' followed by 26 characters",
					},
				},
			],
		},
	],
});
