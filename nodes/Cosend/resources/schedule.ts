import type { INodeProperties } from 'n8n-workflow';

import {
	connectionLocator,
	idempotencyKeyOption,
	sendWithIdempotencyKey,
} from '../shared/descriptions';

const show = { resource: ['schedule'] };
const on = (...operations: string[]) => ({ ...show, operation: operations });

/**
 * A2 §5.10 — anchored reminder ladders.
 *
 * **There is no Recurring option, and leaving it out is the point.** The API's
 * `createScheduleRequest` accepts `kind: 'recurring'` in its zod enum and then **refuses it in the
 * service** with `400 recurring_schedules_not_available` (plan NOTIFY-6): RFC 5545 expansion was
 * deferred. A `Kind` dropdown offering Recurring would be a dropdown entry that cannot run —
 * standing rule 9 — so the node sends `kind: 'anchored'` and offers no choice at all.
 *
 * That also settles W12 for this node: no recurrence library is needed, because there is no
 * recurrence to express. Nothing here does date, timezone or daylight-saving arithmetic either —
 * `Timezone` and `DST Policy` are passed through to Cosend, which owns that maths (rule 12).
 */
export const scheduleDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create a schedule',
				description:
					'Set up a ladder of reminders around one appointment, for example 24 hours and 2 hours before',
				routing: {
					request: {
						method: 'POST',
						url: '/schedules',
						// `kind` is required by the schema and the node only ever sends one value.
						body: { kind: 'anchored' },
					},
					...sendWithIdempotencyKey,
				},
			},
		],
		default: 'create',
	},

	{
		...connectionLocator({
			required: true,
			description: 'Which of your WhatsApp numbers sends these reminders',
		}),
		displayOptions: { show: on('create') },
		routing: { send: { type: 'body', property: 'connection_id' } },
	},
	{
		displayName: 'To',
		name: 'to',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. +919876543210',
		description: 'Who to remind: a phone number in E.164 format, or a Cosend contact ID',
		displayOptions: { show: on('create') },
		routing: { send: { type: 'body', property: 'to' } },
	},
	{
		displayName: 'Anchor Time',
		name: 'anchorAt',
		type: 'dateTime',
		default: '',
		required: true,
		description:
			'The appointment itself. Every reminder is measured backwards from this moment, so this is not when anything is sent.',
		displayOptions: { show: on('create') },
		routing: { send: { type: 'body', property: 'anchor_at' } },
	},
	{
		displayName: 'Reminder Offsets (Minutes)',
		name: 'offsetsMinutes',
		type: 'string',
		default: '1440,120',
		required: true,
		placeholder: 'e.g. 1440,120',
		description:
			'Comma-separated minutes before the anchor time to send a reminder. ‘1440,120’ means one a day before and one two hours before. Between 1 and 24 rungs.',
		displayOptions: { show: on('create') },
		routing: {
			send: {
				type: 'body',
				property: 'offsets_minutes',
				value: '={{ $value.split(",").map(o => Number(o.trim())).filter(o => !isNaN(o)) }}',
			},
		},
	},
	{
		displayName: 'Template by Offset',
		name: 'templateByOffset',
		type: 'json',
		default: '{\n  "1440": "appointment_reminder_24h",\n  "120": "appointment_reminder_2h"\n}',
		description:
			'Which approved template each rung sends, keyed by its offset in minutes. A rung with no entry uses the schedule’s default.',
		displayOptions: { show: on('create') },
		routing: {
			send: { type: 'body', property: 'template_by_offset', value: '={{ JSON.parse($value) }}' },
		},
	},
	{
		displayName: 'Timezone',
		name: 'timezone',
		type: 'string',
		default: 'UTC',
		required: true,
		placeholder: 'e.g. Asia/Kolkata',
		description:
			'An IANA timezone identifier, never a UTC offset. Cosend resolves the reminder times in it and re-resolves them if the timezone database changes.',
		displayOptions: { show: on('create') },
		routing: { send: { type: 'body', property: 'timezone' } },
	},

	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: on('create') },
		options: [
			{
				displayName: 'DST Policy',
				name: 'dstPolicy',
				type: 'options',
				default: 'shift_forward',
				description:
					'What to do when a reminder lands in an hour that daylight saving skipped or repeated',
				options: [
					{ name: 'First', value: 'first', description: 'On a repeated hour, use the first one' },
					{ name: 'Last', value: 'last', description: 'On a repeated hour, use the second one' },
					{ name: 'Shift Back', value: 'shift_back', description: 'Move it earlier past the gap' },
					{
						name: 'Shift Forward',
						value: 'shift_forward',
						description: 'Move it later past the gap',
					},
					{ name: 'Skip', value: 'skip', description: 'Do not send that rung at all' },
				],
				routing: { send: { type: 'body', property: 'dst_policy' } },
			},
			{
				displayName: 'Expires Policy',
				name: 'expiresPolicy',
				type: 'string',
				default: '',
				placeholder: 'e.g. before_anchor_minutes:30',
				description:
					'Drop a reminder that has not gone out by this many minutes before the anchor. Written as ‘before_anchor_minutes:’ followed by a number.',
				routing: { send: { type: 'body', property: 'expires_policy' } },
			},
			idempotencyKeyOption,
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				placeholder: 'e.g. Dental check-up for Priya',
				description: 'A label for this schedule, so your team can find it in Cosend',
				routing: { send: { type: 'body', property: 'name' } },
			},
			{
				displayName: 'Parameters',
				name: 'params',
				type: 'json',
				default: '{}',
				description: 'Values for the templates’ variables, as a JSON object of name/value pairs',
				routing: { send: { type: 'body', property: 'params', value: '={{ JSON.parse($value) }}' } },
			},
			{
				displayName: 'Priority',
				name: 'priority',
				type: 'number',
				default: 1,
				typeOptions: { minValue: 0, maxValue: 3 },
				description:
					'Which reminders go first when the queue is busy. 0 is the most urgent, 3 the least.',
				routing: { send: { type: 'body', property: 'priority' } },
			},
			// ── quiet hours ────────────────────────────────────────────────────────────────────
			//
			// ⚠️ **THE TIMEZONE IS DELIBERATELY NOT NAMED IN THESE DESCRIPTIONS.**
			// Decision W11 says quiet hours run on the ORGANISATION's timezone. The notify
			// module's own `quietHours` schema comment says the RECIPIENT's, citing Doc 04 §8.5.
			// They cannot both be true, it is not this track's module to change, and standing
			// rule 10 forbids writing a sentence into a description that might be the false one.
			// So the fields describe what they do and say nothing about whose clock decides.
			// Raised as an open question in the handoff.
			{
				displayName: 'Quiet Hours End',
				name: 'quietHoursEnd',
				type: 'string',
				default: '',
				placeholder: 'e.g. 08:00',
				description: 'When the quiet period ends, as HH:MM on a 24-hour clock',
				routing: {
					send: { type: 'body', property: 'quiet_hours.end', propertyInDotNotation: true },
				},
			},
			{
				displayName: 'Quiet Hours Policy',
				name: 'quietHoursPolicy',
				type: 'options',
				default: 'shift_to_end',
				description: 'What to do with a reminder that falls inside the quiet period',
				options: [
					{ name: 'Ignore', value: 'ignore', description: 'Send it anyway' },
					{
						name: 'Shift to End',
						value: 'shift_to_end',
						description: 'Hold it until the quiet period ends',
					},
					{
						name: 'Shift to Start',
						value: 'shift_to_start',
						description: 'Send it just before the quiet period begins',
					},
					{ name: 'Skip', value: 'skip', description: 'Do not send that rung at all' },
				],
				routing: {
					send: { type: 'body', property: 'quiet_hours.policy', propertyInDotNotation: true },
				},
			},
			{
				displayName: 'Quiet Hours Start',
				name: 'quietHoursStart',
				type: 'string',
				default: '',
				placeholder: 'e.g. 21:00',
				description: 'When the quiet period begins, as HH:MM on a 24-hour clock',
				routing: {
					send: { type: 'body', property: 'quiet_hours.start', propertyInDotNotation: true },
				},
			},
			{
				displayName: 'Skip if Late (Minutes)',
				name: 'skipIfLateMinutes',
				type: 'number',
				default: 0,
				typeOptions: { minValue: 0, maxValue: 10080 },
				description:
					'Drop a reminder that is running more than this many minutes behind its planned time',
				routing: { send: { type: 'body', property: 'skip_if_late_minutes' } },
			},
		],
	},
];
