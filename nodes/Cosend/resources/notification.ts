import type { INodeProperties } from 'n8n-workflow';

import {
	connectionLocator,
	idempotencyKeyOption,
	sendWithIdempotencyKey,
} from '../shared/descriptions';

const show = { resource: ['notification'] };
const on = (...operations: string[]) => ({ ...show, operation: operations });

/**
 * A2 §5.9 — the notify rail.
 *
 * **Doc 03 does not describe this resource, and the route table marks it for n8n.** The marker is
 * the contract: `POST /v1/notifications` carries `n8n: { resource: 'notification', operation:
 * 'send' }`, and a marked route no node operation exposes is a built feature that is not switched
 * on — standing rule 9's second half.
 *
 * It is a different thing from `Message: Send`, not a duplicate of it. A message is sent now and
 * fails if it cannot be. A notification is *queued*: it can be scheduled, it expires rather than
 * arriving late, it deduplicates on a key, and it carries a priority. A2 §5.9's own words for the
 * expiry: *"A reminder for a 3pm appointment delivered at 6pm is worse than none."*
 */
export const notificationDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Send',
				value: 'send',
				action: 'Send a notification',
				description:
					'Queue one notification. Cosend picks a template or free-form text depending on whether the 24-hour window is open.',
				routing: {
					request: { method: 'POST', url: '/notifications' },
					...sendWithIdempotencyKey,
				},
			},
		],
		default: 'send',
	},

	{
		...connectionLocator({
			required: true,
			description: 'Which of your WhatsApp numbers sends this notification',
		}),
		displayOptions: { show: on('send') },
		routing: { send: { type: 'body', property: 'connection_id' } },
	},
	{
		displayName: 'To',
		name: 'to',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. +919876543210',
		description: 'Who to notify — a phone number in E.164 format, or a Cosend contact ID',
		displayOptions: { show: on('send') },
		routing: { send: { type: 'body', property: 'to' } },
	},
	{
		displayName: 'Send Mode',
		name: 'sendMode',
		type: 'options',
		default: 'auto',
		description: 'How Cosend decides what to send',
		displayOptions: { show: on('send') },
		options: [
			{
				name: 'Auto',
				value: 'auto',
				description:
					'Send free-form text if the 24-hour window is open, otherwise the template. The result reports which was used.',
			},
			{
				name: 'Freeform',
				value: 'freeform',
				description: 'Always send the free-form body. Fails when the window has closed.',
			},
			{ name: 'Template', value: 'template', description: 'Always send the approved template' },
		],
		routing: { send: { type: 'body', property: 'send_mode' } },
	},

	// The API refines this: `template` mode without a template, or `freeform` without a body, is a
	// 400 naming the field. The `required` flags below mirror those two refinements exactly, so
	// n8n catches them in the editor rather than at run time.
	{
		displayName: 'Template Name',
		name: 'templateName',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. appointment_reminder',
		description: 'The approved template to send',
		displayOptions: { show: { ...on('send'), sendMode: ['auto', 'template'] } },
		routing: { send: { type: 'body', property: 'template.name', propertyInDotNotation: true } },
	},
	{
		displayName: 'Template Language',
		name: 'templateLanguage',
		type: 'string',
		default: 'en_US',
		required: true,
		placeholder: 'e.g. en_US',
		description: 'The language code of the approved template',
		displayOptions: { show: { ...on('send'), sendMode: ['auto', 'template'] } },
		routing: {
			send: { type: 'body', property: 'template.language', propertyInDotNotation: true },
		},
	},
	{
		displayName: 'Template Parameters',
		name: 'templateParams',
		type: 'json',
		default: '{}',
		description: 'The template’s variable values, as a JSON object of name/value pairs',
		displayOptions: { show: { ...on('send'), sendMode: ['auto', 'template'] } },
		routing: {
			send: {
				type: 'body',
				property: 'template.params',
				propertyInDotNotation: true,
				value: '={{ JSON.parse($value) }}',
			},
		},
	},
	{
		displayName: 'Message',
		name: 'fallbackBody',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		required: true,
		description:
			'The free-form text to send while the 24-hour window is open. With ‘Send Mode’ set to ‘Freeform’ this is the whole message.',
		displayOptions: { show: { ...on('send'), sendMode: ['auto', 'freeform'] } },
		routing: {
			// A1 §8's column is `body`; the wire name is A2 §5.9's `fallback_body`, and the payload
			// is `{ type: 'text', ... }` — `freeFormBody` is `{ type: string }` with a catchall.
			send: {
				type: 'body',
				property: 'fallback_body',
				value: '={{ { type: "text", body: $value } }}',
			},
		},
	},

	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: on('send') },
		options: [
			{
				displayName: 'Deduplication Key',
				name: 'dedupKey',
				type: 'string',
				default: '',
				description:
					'A key that stops the same notification going out twice. A second send with this key returns the first notification instead of queueing another.',
				routing: { send: { type: 'body', property: 'dedup_key' } },
			},
			{
				displayName: 'Expires At',
				name: 'expiresAt',
				type: 'dateTime',
				default: '',
				description:
					'Drop this notification rather than deliver it after this time. A reminder that arrives hours late is worse than none.',
				routing: { send: { type: 'body', property: 'expires_at' } },
			},
			idempotencyKeyOption,
			{
				displayName: 'Priority',
				name: 'priority',
				type: 'number',
				default: 2,
				typeOptions: { minValue: 0, maxValue: 3 },
				description:
					'Which notifications go first when the queue is busy. 0 is the most urgent, 3 the least.',
				routing: { send: { type: 'body', property: 'priority' } },
			},
			{
				displayName: 'Scheduled For',
				name: 'scheduledFor',
				type: 'dateTime',
				default: '',
				description: 'When to send this. Leave empty to queue it now.',
				routing: { send: { type: 'body', property: 'scheduled_for' } },
			},
		],
	},
];
