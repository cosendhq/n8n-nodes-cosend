import type { INodeProperties } from 'n8n-workflow';

import {
	connectionLocator,
	contactLocator,
	paginationProperties,
	unwrapData,
} from '../shared/descriptions';

const show = { resource: ['contact'] };
const on = (...operations: string[]) => ({ ...show, operation: operations });

/**
 * A2 §5.6 — contacts.
 *
 * **Create and Upsert are different operations, because `POST /v1/contacts` does not update.**
 * A2 §5.6: a create for an existing `(connection_id, phone_e164)` "returns the existing contact
 * with `200`" — unchanged; the fields sent with it are not written. Create is that call. Upsert
 * (`operations/upsertContact.ts`) is what cosend.app/n8n promises — "looks up by phone number and
 * then writes" — so it follows a `200` with a `PATCH` of the same fields.
 *
 * Add Tags and Remove Tags change only the tags they name (`POST` and `DELETE
 * /v1/contacts/{id}/tags`), so two workflows tagging one contact cannot lose each other's tag the
 * way two Updates, each replacing the whole list, can.
 */
export const contactDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Add Tags',
				value: 'addTags',
				action: 'Add tags to a contact',
				description: 'Add tags to a contact. A tag it already has is left as it is.',
				routing: {
					request: { method: 'POST', url: '=/contacts/{{ $parameter.contactId }}/tags' },
				},
			},
			{
				name: 'Create',
				value: 'create',
				action: 'Create a contact',
				description:
					"Add a contact. If this number already has one on this connection, you get that contact back unchanged — use 'Create or Update' to update it.",
				routing: { request: { method: 'POST', url: '/contacts' } },
			},
			{
				name: 'Delete',
				value: 'delete',
				action: 'Delete a contact',
				description: 'Remove a contact from the workspace',
				routing: { request: { method: 'DELETE', url: '=/contacts/{{ $parameter.contactId }}' } },
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get a contact',
				description: 'Retrieve one contact by ID, phone number or WhatsApp business-scoped ID',
				routing: { request: { method: 'GET', url: '=/contacts/{{ $parameter.contactId }}' } },
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many contacts',
				description: 'Retrieve a list of contacts',
				routing: { request: { method: 'GET', url: '/contacts' }, ...unwrapData },
			},
			{
				name: 'Remove Tags',
				value: 'removeTags',
				action: 'Remove tags from a contact',
				description: 'Remove tags from a contact. A tag it does not have is ignored.',
				routing: {
					request: { method: 'DELETE', url: '=/contacts/{{ $parameter.contactId }}/tags' },
				},
			},
			{
				name: 'Update',
				value: 'update',
				action: 'Update a contact',
				description: 'Change the stored details of an existing contact',
				routing: { request: { method: 'PATCH', url: '=/contacts/{{ $parameter.contactId }}' } },
			},
			{
				// cosend.app/n8n calls this Upsert; n8n's linter requires an upsert to be named
				// "Create or Update" with exactly this description (`node-param-*-wrong-for-upsert`).
				name: 'Create or Update',
				value: 'upsert',
				action: 'Create or update a contact',
				description: 'Create a new record, or update the current one if it already exists (upsert)',
			},
		],
		default: 'getAll',
	},

	{
		...contactLocator('The contact to act on'),
		displayOptions: { show: on('get', 'update', 'delete', 'addTags', 'removeTags') },
	},
	{
		displayName: 'Tags',
		name: 'tags',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. vip,india',
		description: 'Comma-separated tags. The contact keeps every other tag it has.',
		displayOptions: { show: on('addTags', 'removeTags') },
		routing: {
			send: {
				type: 'body',
				property: 'tags',
				value: '={{ $value.split(",").map(t => t.trim()).filter(t => t) }}',
			},
		},
	},

	// ── create, upsert ────────────────────────────────────────────────────────────────────────
	// Upsert is a custom operation and reads these itself; the routing below is Create's.
	{
		...connectionLocator({
			required: true,
			// `createContactRequest.connection_id` is a required string, not an optional one — a
			// contact belongs to one WhatsApp number, so there is no workspace-wide contact.
			description: 'The WhatsApp connection this contact belongs to',
		}),
		displayOptions: { show: on('create', 'upsert') },
		routing: { send: { type: 'body', property: 'connection_id' } },
	},
	{
		displayName: 'Phone Number',
		name: 'phoneE164',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. +919876543210',
		description: "The contact's WhatsApp number in E.164 format, including the country code",
		displayOptions: { show: on('create', 'upsert') },
		routing: { send: { type: 'body', property: 'phone_e164' } },
	},

	// ── create + update + upsert: the settable fields, and only the settable fields ────────────
	//
	// `createContactRequest` and `patchContactRequest` are both `.strict()`, so any field the node
	// invents is a 400 rather than a silently ignored extra. Doc 03 §4.3 names `Name`, `Email`,
	// `Opt-In Status`, `Custom Fields` and `Assigned Agent ID`; the schemas carry `profile_name`,
	// `attributes`, `tags`, `locale`, `timezone` and `is_blocked`. Transcribing Doc 03 would have
	// produced a Contact resource where every write failed.
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: on('create', 'update', 'upsert') },
		options: [
			{
				displayName: 'Attributes',
				name: 'attributes',
				type: 'json',
				default: '{}',
				description:
					'Your own structured data about this contact, as a JSON object. Cosend stores it and echoes it on every webhook about the contact, for example \'{ "crm_id": "4821" }\'.',
				routing: {
					send: { type: 'body', property: 'attributes', value: '={{ JSON.parse($value) }}' },
				},
			},
			{
				displayName: 'Locale',
				name: 'locale',
				type: 'string',
				default: '',
				placeholder: 'e.g. en_US',
				description: "The contact's preferred language, used to pick a template language",
				routing: { send: { type: 'body', property: 'locale' } },
			},
			{
				displayName: 'Profile Name',
				name: 'profileName',
				type: 'string',
				default: '',
				description:
					"The display name for this contact. WhatsApp supplies one from the contact's own profile; setting it here overrides that.",
				routing: { send: { type: 'body', property: 'profile_name' } },
			},
			{
				displayName: 'Tags',
				name: 'tags',
				type: 'string',
				default: '',
				placeholder: 'e.g. vip,india',
				description:
					'Comma-separated labels for this contact. This REPLACES the existing tags rather than adding to them.',
				routing: {
					send: {
						type: 'body',
						property: 'tags',
						value: '={{ $value.split(",").map(t => t.trim()).filter(t => t) }}',
					},
				},
			},
			{
				displayName: 'Timezone',
				name: 'timezone',
				type: 'string',
				default: '',
				placeholder: 'e.g. Asia/Kolkata',
				description: "The contact's IANA timezone identifier, never a UTC offset",
				routing: { send: { type: 'body', property: 'timezone' } },
			},
		],
	},
	{
		displayName: 'Blocked',
		name: 'isBlocked',
		type: 'boolean',
		default: false,
		// `is_blocked` is on the PATCH schema only — offering it on Create would be a 400.
		description: 'Whether to block this contact, which stops Cosend delivering their messages',
		displayOptions: { show: on('update') },
		routing: { send: { type: 'body', property: 'is_blocked' } },
	},

	// ── getAll ────────────────────────────────────────────────────────────────────────────────
	...paginationProperties(on('getAll')),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: on('getAll') },
		options: [
			{
				...connectionLocator({
					required: false,
					description: 'Only return contacts belonging to this WhatsApp connection',
				}),
				routing: { send: { type: 'query', property: 'connection_id' } },
			},
			{
				displayName: 'Search',
				name: 'q',
				type: 'string',
				default: '',
				description: 'Only return contacts whose display name matches this text',
				routing: { send: { type: 'query', property: 'q' } },
			},
			{
				displayName: 'Tags',
				name: 'tag',
				type: 'string',
				default: '',
				placeholder: 'e.g. vip,india',
				// A2 §5.6: "`tags` is an array with `?tag=vip&tag=india` (AND semantics)". The API
				// reads a repeated parameter, so an array value is the honest shape here, and the
				// description says AND because that is what it does — not OR.
				description:
					'Comma-separated tags. A contact must carry ALL of them to be returned, not just one.',
				routing: {
					send: {
						type: 'query',
						property: 'tag',
						value: '={{ $value.split(",").map(t => t.trim()).filter(t => t) }}',
					},
				},
			},
		],
	},
];
