import type { INodeProperties } from 'n8n-workflow';

import {
	connectionLocator,
	idempotencyKeyOption,
	paginationProperties,
	sendWithIdempotencyKey,
	unwrapData,
} from '../shared/descriptions';

const show = { resource: ['automation'] };
const on = (...operations: string[]) => ({ ...show, operation: operations });

/**
 * A2 §5.11 and §5.12 — automations and their runs.
 *
 * cosend.app/n8n promises four operations and the route table marks exactly the four routes behind
 * them: Trigger is `POST /v1/runs`, Get Many is `GET /v1/automations`, Get Run is
 * `GET /v1/runs/{id}` and Get Run Events is `GET /v1/runs/{id}/events` — "the per-step trace, so a
 * failing automation is debuggable from inside n8n". Building and editing automations stays in
 * Cosend: a workflow starts one and reads what it did.
 */
export const automationDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many automations',
				description: 'List your automations, with how each one ran today',
				routing: { request: { method: 'GET', url: '/automations' }, ...unwrapData },
			},
			{
				name: 'Get Run',
				value: 'getRun',
				action: 'Get an automation run',
				description:
					'Retrieve one run: its state, when it started and finished, and why it stopped',
				routing: { request: { method: 'GET', url: '=/runs/{{ $parameter.runId }}' } },
			},
			{
				name: 'Get Run Events',
				value: 'getRunEvents',
				action: 'Get the events of an automation run',
				description:
					'Retrieve the step-by-step trace of one run, so you can see which step failed and why',
				routing: {
					request: { method: 'GET', url: '=/runs/{{ $parameter.runId }}/events' },
					...unwrapData,
				},
			},
			{
				name: 'Trigger',
				value: 'trigger',
				action: 'Trigger an automation',
				description:
					'Start one run of an automation by hand. The answer is the run, which you can read again with Get Run.',
				routing: {
					request: { method: 'POST', url: '/runs' },
					...sendWithIdempotencyKey,
				},
			},
		],
		default: 'trigger',
	},

	// ── trigger ───────────────────────────────────────────────────────────────────────────────
	{
		displayName: 'Automation',
		name: 'automationId',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: 'The automation to start',
		displayOptions: { show: on('trigger') },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchAutomations', searchable: true },
			},
			{
				displayName: 'ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. aut_01H8XK3M9PQRSTUVWXYZ01ABCD',
				validation: [
					{
						type: 'regex',
						properties: {
							regex: '^aut_[0-9A-HJKMNP-TV-Z]{26}$',
							errorMessage: "An automation ID looks like 'aut_' followed by 26 characters",
						},
					},
				],
			},
		],
		routing: { send: { type: 'body', property: 'automation_id' } },
	},
	{
		displayName: 'Payload',
		name: 'payload',
		type: 'json',
		default: '{}',
		description:
			'The data the run starts with, as a JSON object. Its steps read it the way they read the message or order that normally starts the automation.',
		displayOptions: { show: on('trigger') },
		routing: {
			// An expression such as `{{ $json.order }}` already hands over an object; only the text
			// typed into the field needs parsing.
			send: {
				type: 'body',
				property: 'payload',
				value: '={{ typeof $value === "string" ? JSON.parse($value) : $value }}',
			},
		},
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: on('trigger') },
		options: [idempotencyKeyOption],
	},

	// ── getRun, getRunEvents ──────────────────────────────────────────────────────────────────
	{
		displayName: 'Run ID',
		name: 'runId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. run_01H8XK3M9PQRSTUVWXYZ01ABCD',
		description:
			'The run to read. Trigger returns it as the run’s ID, and so does every automation event.',
		displayOptions: { show: on('getRun', 'getRunEvents') },
	},

	// ── getAll, getRunEvents: both are A2 §3.2 lists ──────────────────────────────────────────
	...paginationProperties(on('getAll', 'getRunEvents')),
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
					description: 'Only return automations on this WhatsApp connection',
				}),
				routing: { send: { type: 'query', property: 'connection_id' } },
			},
		],
	},
];
