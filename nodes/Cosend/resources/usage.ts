import type { INodeProperties } from 'n8n-workflow';

const show = { resource: ['usage'] };

/**
 * A2 §5.15 — `GET /v1/usage`.
 *
 * cosend.app/n8n: "So a workflow can react to its own consumption: post to Slack when AI
 * conversations pass 80% of what is included." Every meter comes back with what was used and
 * what the plan includes, so the workflow does not have to know the pricing.
 *
 * **Get only.** There is no Get Breakdown: `GET /v1/usage/breakdown` is not built
 * (`src/modules/billing/routes.ts` says why) and the node does not offer one.
 */
export const usageDescription: INodeProperties[] = [
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
				action: 'Get usage',
				description:
					'Retrieve one billing period’s usage: each meter’s count, and what your plan includes',
				routing: { request: { method: 'GET', url: '/usage' } },
			},
		],
		default: 'get',
	},
	{
		// An option rather than a field, so it is sent only when it is set: leaving `period` out
		// means the current period, and an empty one is refused.
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { ...show, operation: ['get'] } },
		options: [
			{
				displayName: 'Period',
				name: 'period',
				type: 'string',
				default: '',
				placeholder: 'e.g. 2026-08',
				description:
					'The month the billing period starts in, as YYYY-MM. Without it you get the current period.',
				routing: { send: { type: 'query', property: 'period' } },
			},
		],
	},
];
