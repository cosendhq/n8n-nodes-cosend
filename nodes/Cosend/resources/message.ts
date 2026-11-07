import type { INodeProperties } from 'n8n-workflow';

import {
	connectionLocator,
	contactLocator,
	conversationLocator,
	idempotencyKeyOption,
	paginationProperties,
	sendWithIdempotencyKey,
	unwrapData,
} from '../shared/descriptions';
import { outputProperties } from '../shared/output';

const show = { resource: ['message'] };
const on = (...operations: string[]) => ({ ...show, operation: operations });
const sending = on('send', 'sendBatch');

/** `Send` and `Send Batch` take the same message parameters, shown for both. */
const forType = (...types: string[]) => ({ ...sending, messageType: types });

/**
 * A2 §5.4 — messages.
 *
 * `Send` and `Send Batch` are `customOperations`: `Send` may have to upload a binary attachment
 * first (`POST /v1/media`, then send by media ID), and `Send Batch` folds many n8n items into one
 * `POST /v1/messages/batch` and maps the `207` results back onto `pairedItem` by index. Neither is
 * expressible declaratively. The other four operations are pure routing.
 *
 * **The type-specific object is WhatsApp's own shape, passed through unchanged.** The API's
 * `contentFor` pulls `body[body.type]` off the request and hands it to Meta verbatim, so the
 * parameters below build `text: { body }`, `image: { link | id, caption }`,
 * `template: { name, language: { code }, components }` and so on.
 */
export const messageDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Get',
				value: 'get',
				action: 'Get message',
				description: 'Retrieve one message by its Cosend ID or its WhatsApp message ID',
				routing: { request: { method: 'GET', url: '=/messages/{{ $parameter.messageId }}' } },
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many messages',
				description: 'Retrieve a list of messages',
				routing: { request: { method: 'GET', url: '/messages' }, ...unwrapData },
			},
			{
				name: 'Mark as Read',
				value: 'markRead',
				action: 'Mark message as read',
				description: 'Mark a message as read, which shows blue ticks on the contact’s phone',
				routing: {
					request: { method: 'POST', url: '=/messages/{{ $parameter.messageId }}/read' },
					...sendWithIdempotencyKey,
				},
			},
			{
				name: 'React',
				value: 'react',
				action: 'React to message',
				description: 'Add an emoji reaction to a message, or clear the one already on it',
				routing: {
					request: { method: 'POST', url: '=/messages/{{ $parameter.messageId }}/reactions' },
					...sendWithIdempotencyKey,
				},
			},
			{
				name: 'Send',
				value: 'send',
				action: 'Send message',
				description: 'Send one WhatsApp message per input item',
			},
			{
				name: 'Send Batch',
				value: 'sendBatch',
				action: 'Send batch of messages',
				description:
					'Send many messages in one request, up to 100 at a time. Each message gets its own result.',
			},
		],
		default: 'send',
	},

	// ── the message a path parameter names ────────────────────────────────────────────────────
	{
		displayName: 'Message ID',
		name: 'messageId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. msg_01J9Z3K8M2Q4R6T8V0W2X4Y6Z8',
		description:
			'The message to act on: its Cosend ID, or the WhatsApp message ID from a webhook',
		displayOptions: { show: on('get', 'markRead', 'react') },
	},
	{
		displayName: 'Emoji',
		name: 'emoji',
		type: 'string',
		default: '',
		placeholder: 'e.g. 👍',
		// A2 §5.4: "an empty string removes the reaction". `reactionRequest` is `z.string()` with
		// no `.min(1)`, so empty is a legal value and not a missing one — hence `required: false`.
		description:
			'The emoji to react with. Leave this empty to remove the reaction already on the message.',
		displayOptions: { show: on('react') },
		routing: { send: { type: 'body', property: 'emoji' } },
	},

	// ── send / sendBatch: who it goes to ──────────────────────────────────────────────────────
	{
		displayName: 'Send To',
		name: 'sendTo',
		type: 'options',
		default: 'contact',
		description: 'How to address this message',
		displayOptions: { show: sending },
		options: [
			{
				name: 'Contact',
				value: 'contact',
				description: 'A phone number or a contact. Cosend finds or opens the conversation.',
			},
			{
				name: 'Conversation',
				value: 'conversation',
				description: 'An existing thread. Cosend takes the WhatsApp number and contact from it.',
			},
		],
	},
	{
		...contactLocator(
			'Who to send to. A phone number that has never messaged you is fine: Cosend creates the contact.',
		),
		displayOptions: { show: { ...sending, sendTo: ['contact'] } },
	},
	{
		...conversationLocator('The conversation to reply in'),
		displayOptions: { show: { ...sending, sendTo: ['conversation'] } },
	},
	{
		...connectionLocator({
			required: false,
			description:
				'Which of your WhatsApp numbers sends this. Leave empty when the credential is a connection key, because it already names one.',
		}),
		displayOptions: { show: { ...sending, sendTo: ['contact'] } },
	},

	// ── send / sendBatch: what it is ──────────────────────────────────────────────────────────
	{
		displayName: 'Message Type',
		name: 'messageType',
		type: 'options',
		default: 'text',
		description: 'The kind of WhatsApp message to send',
		displayOptions: { show: sending },
		// `reaction` is a valid value of the API's `messageType` enum and is deliberately absent:
		// `React` is its own operation on its own endpoint. Two ways to do one thing is what n8n's
		// UX guidelines and CLAUDE.md both tell us not to build.
		options: [
			{ name: 'Audio', value: 'audio', description: 'A voice note or audio file' },
			{ name: 'Contacts', value: 'contacts', description: 'One or more contact cards' },
			{ name: 'Document', value: 'document', description: 'A PDF or other file' },
			{ name: 'Image', value: 'image', description: 'A photo, with an optional caption' },
			{
				name: 'Interactive',
				value: 'interactive',
				description: 'Reply buttons or a list the contact picks from',
			},
			{ name: 'Location', value: 'location', description: 'A point on the map' },
			{ name: 'Sticker', value: 'sticker', description: 'A WhatsApp sticker' },
			{
				name: 'Template',
				value: 'template',
				description:
					'A message Meta approved in advance. The only thing you may send outside the 24-hour window.',
			},
			{ name: 'Text', value: 'text', description: 'Plain text, with optional link previews' },
			{ name: 'Video', value: 'video', description: 'A video, with an optional caption' },
		],
	},

	// text
	{
		displayName: 'Message',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		required: true,
		description: 'The text to send',
		displayOptions: { show: forType('text') },
	},
	{
		displayName: 'Preview Links',
		name: 'previewUrl',
		type: 'boolean',
		default: false,
		description:
			'Whether WhatsApp should show a preview card for the first link in the message. The contact sees the link either way.',
		displayOptions: { show: forType('text') },
	},

	// media
	{
		displayName: 'Media Source',
		name: 'mediaSource',
		type: 'options',
		default: 'url',
		description: 'Where the file comes from',
		displayOptions: { show: forType('image', 'video', 'audio', 'document', 'sticker') },
		options: [
			{
				name: 'Binary File',
				value: 'binary',
				description:
					'A file on the input item. Cosend uploads it first, which costs one extra request.',
			},
			{
				name: 'Media ID',
				value: 'id',
				description: 'A file already uploaded to Cosend or WhatsApp',
			},
			{ name: 'URL', value: 'url', description: 'A public link WhatsApp can fetch' },
		],
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		hint: 'The name of the input binary field containing the file',
		displayOptions: {
			show: {
				...forType('image', 'video', 'audio', 'document', 'sticker'),
				mediaSource: ['binary'],
			},
		},
	},
	{
		displayName: 'Media URL',
		name: 'mediaUrl',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. https://example.com/invoice.pdf',
		description: 'A public link. WhatsApp fetches it directly, so it must not need a login.',
		displayOptions: {
			show: { ...forType('image', 'video', 'audio', 'document', 'sticker'), mediaSource: ['url'] },
		},
	},
	{
		displayName: 'Media ID',
		name: 'mediaId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. med_01J9Z3K8M2Q4R6T8V0W2X4Y6Z8',
		description: 'The ID of a file already uploaded to Cosend',
		displayOptions: {
			show: { ...forType('image', 'video', 'audio', 'document', 'sticker'), mediaSource: ['id'] },
		},
	},
	{
		displayName: 'Caption',
		name: 'caption',
		type: 'string',
		default: '',
		// Meta accepts `caption` on image, video and document only — not audio, not sticker.
		description: 'Text shown under the file',
		displayOptions: { show: forType('image', 'video', 'document') },
	},
	{
		displayName: 'File Name',
		name: 'filename',
		type: 'string',
		default: '',
		placeholder: 'e.g. invoice-4821.pdf',
		description: 'The name the contact sees when they save the file',
		displayOptions: { show: forType('document') },
	},

	// template
	{
		displayName: 'Template Name',
		name: 'templateName',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: 'The approved template to send',
		displayOptions: { show: forType('template') },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchTemplates', searchable: true },
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				placeholder: 'e.g. appointment_reminder',
			},
		],
	},
	{
		displayName: 'Language',
		name: 'templateLanguage',
		type: 'string',
		default: 'en_US',
		required: true,
		placeholder: 'e.g. en_US',
		// G14: "Each template has a language selected to it, so we should keep this in the record."
		// A template name is not unique on its own — the same name exists per language.
		description:
			'The language code of the approved template. A template name is not unique on its own: the same name exists once per language.',
		displayOptions: { show: forType('template') },
	},
	{
		displayName: 'Components',
		name: 'templateComponents',
		type: 'json',
		default: '[]',
		description:
			'The template’s variable values, as WhatsApp’s own components array. Leave as [] for a template with no variables.',
		hint: 'For example: [{"type":"body","parameters":[{"type":"text","text":"Priya"}]}]',
		displayOptions: { show: forType('template') },
	},

	// the shapes WhatsApp defines and we pass through unchanged
	{
		displayName: 'Location',
		name: 'location',
		type: 'json',
		default: '{\n  "latitude": 0,\n  "longitude": 0,\n  "name": "",\n  "address": ""\n}',
		required: true,
		description: 'The point to send, as WhatsApp’s own location object',
		displayOptions: { show: forType('location') },
	},
	{
		displayName: 'Contacts',
		name: 'contacts',
		type: 'json',
		default: '[]',
		required: true,
		description: 'The contact cards to send, as WhatsApp’s own contacts array',
		displayOptions: { show: forType('contacts') },
	},
	{
		displayName: 'Interactive',
		name: 'interactive',
		type: 'json',
		default: '{}',
		required: true,
		description: 'The buttons or list to send, as WhatsApp’s own interactive object',
		hint: 'For example: {"type":"button","body":{"text":"Confirm?"},"action":{"buttons":[{"type":"reply","reply":{"id":"yes","title":"Yes"}}]}}',
		displayOptions: { show: forType('interactive') },
	},

	// ── send / sendBatch: options ─────────────────────────────────────────────────────────────
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: sending },
		options: [
			{
				displayName: 'Fallback Template Language',
				name: 'fallbackTemplateLanguage',
				type: 'string',
				default: 'en_US',
				description: "The language of the fallback template. Only used when 'Send Mode' is 'Auto'.",
			},
			{
				displayName: 'Fallback Template Name',
				name: 'fallbackTemplateName',
				type: 'string',
				default: '',
				description:
					"The approved template to send instead when the 24-hour window has closed. Only used when 'Send Mode' is 'Auto'.",
			},
			idempotencyKeyOption,
			{
				displayName: 'Metadata',
				name: 'metadata',
				type: 'json',
				default: '{}',
				description:
					'Your own key/value data, stored on the message and echoed on every webhook about it. Never sent to WhatsApp. Values must be strings.',
			},
			{
				displayName: 'Reply to Message ID',
				name: 'replyTo',
				type: 'string',
				default: '',
				description:
					'The WhatsApp message ID this message quotes. The contact sees it as a reply.',
			},
			{
				displayName: 'Send As',
				name: 'source',
				type: 'options',
				default: 'api',
				// A1 §6.3's `source`. `agent` is the value the conversation lock is enforced
				// against (A2 §5.5.1) — sending as an agent without holding the lock is a
				// `409 conversation_locked`, which is a surprise worth naming here.
				description: 'Who this message is attributed to in the Cosend inbox',
				options: [
					{ name: 'API', value: 'api', description: 'An integration. This is the usual choice.' },
					{
						name: 'Agent',
						value: 'agent',
						description:
							'A person on your team. Cosend requires the conversation lock for this and refuses the send without it.',
					},
					{ name: 'Automation', value: 'automation', description: 'A Cosend automation' },
				],
			},
			{
				displayName: 'Send Mode',
				name: 'sendMode',
				type: 'options',
				default: 'strict',
				description: 'What to do when the 24-hour service window has closed',
				options: [
					{
						name: 'Strict',
						value: 'strict',
						description: 'Fail with an error. You find out the window was shut.',
					},
					{
						name: 'Auto',
						value: 'auto',
						description:
							"Send the fallback template instead. The result reports which was used in 'send_mode_used'.",
					},
				],
			},
		],
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
					description: 'Only return messages on this WhatsApp number',
				}),
				routing: { send: { type: 'query', property: 'connection_id' } },
			},
			{
				...contactLocator('Only return messages to or from this contact'),
				required: false,
				routing: { send: { type: 'query', property: 'contact_id' } },
			},
			{
				...conversationLocator('Only return messages in this conversation'),
				required: false,
				routing: { send: { type: 'query', property: 'conversation_id' } },
			},
			{
				displayName: 'Direction',
				name: 'direction',
				type: 'options',
				default: 'inbound',
				description: 'Only return messages travelling this way',
				options: [
					{ name: 'Inbound', value: 'inbound', description: 'From the contact to you' },
					{ name: 'Outbound', value: 'outbound', description: 'From you to the contact' },
				],
				routing: { send: { type: 'query', property: 'direction' } },
			},
			{
				displayName: 'Source',
				name: 'source',
				type: 'options',
				default: 'api',
				description: 'Only return messages sent by this kind of author',
				options: [
					{ name: 'Agent', value: 'agent' },
					{ name: 'API', value: 'api' },
					{ name: 'App', value: 'app', description: 'The owner’s own WhatsApp Business app' },
					{ name: 'Automation', value: 'automation' },
				],
				routing: { send: { type: 'query', property: 'source' } },
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				default: 'delivered',
				description: 'Only return messages at this delivery status',
				options: [
					{ name: 'Delivered', value: 'delivered' },
					{ name: 'Failed', value: 'failed' },
					{ name: 'Read', value: 'read' },
					{ name: 'Sent', value: 'sent' },
				],
				routing: { send: { type: 'query', property: 'status' } },
			},
		],
	},

	// ── get, getAll: Simplify, or the tool's Output ───────────────────────────────────────────
	...outputProperties(on('get', 'getAll'), 'message'),
];
