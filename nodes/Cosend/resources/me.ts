import type { INodeProperties } from 'n8n-workflow';

const show = { resource: ['me'] };

/**
 * A2 §5.1 — `GET /v1/me`.
 *
 * One operation and no parameters. It is in the node because A2 guarantees it "never fails for
 * authorization reasons", which makes it the one call a workflow can make to discover which
 * workspace and plan the credential belongs to without risking an `insufficient_scope`.
 *
 * Shown as **Workspace**: SPEC §1 *Words* — the customer's account is a workspace on every screen,
 * never an organization. The value stays `me`, so no saved workflow changes.
 */
export const meDescription: INodeProperties[] = [
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
				action: 'Get current workspace',
				description: 'Retrieve the current workspace, with this credential, its plan and limits',
				routing: { request: { method: 'GET', url: '/me' } },
			},
		],
		default: 'get',
	},
];
