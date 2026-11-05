import type { INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import {
	searchAutomations,
	searchConnections,
	searchContacts,
	searchConversations,
	searchTemplates,
} from './listSearch';
import { sendBatch } from './operations/sendBatch';
import { sendMessage } from './operations/sendMessage';
import { upsertContact } from './operations/upsertContact';
import { automationDescription } from './resources/automation';
import { contactDescription } from './resources/contact';
import { conversationDescription } from './resources/conversation';
import { meDescription } from './resources/me';
import { messageDescription } from './resources/message';
import { notificationDescription } from './resources/notification';
import { scheduleDescription } from './resources/schedule';
import { usageDescription } from './resources/usage';
import { surfaceCosendError } from './shared/transport';

/**
 * The Cosend action node — declarative, with three custom operations.
 *
 * **Never called "WhatsApp", deliberately** (Doc 03 §2.5). n8n ships its own WhatsApp Business
 * Cloud node, and the verification guidelines say a node "MUST not be an existing node" and that
 * proxy layers "generally don't qualify". This node integrates **one** third-party service —
 * Cosend — and leads with resources that have no Cloud API equivalent: conversations with control
 * and locking, automations and their per-step traces, usage, notifications that expire rather than
 * arrive late. `baseURL` points at `api.cosend.app` and nowhere else.
 *
 * **The set of operations is not a judgement call.** It is exactly the routes A2 §10.2 marks `n8n:`
 * in the one route table, plus Contact: Upsert, which is built from two of them.
 * `test/contract.test.ts` asserts the equality against a fixture generated from
 * `packages/contracts`, so an operation with no route and a route with no operation are both build
 * failures (standing rule 9, both halves).
 */
export class Cosend implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cosend',
		name: 'cosend',
		icon: { light: 'file:../../icons/cosend.svg', dark: 'file:../../icons/cosend.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Send WhatsApp messages and manage contacts, conversations, automations and usage in Cosend',
		defaults: { name: 'Cosend' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'cosendApi', required: true }],
		requestDefaults: {
			// Verified in n8n core: the built-in Npm node uses the same
			// `requestDefaults: { baseURL: '={{ $credentials.registryUrl }}' }` shape.
			baseURL: '={{$credentials.baseUrl}}',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			// A refusal comes back as a response, so `surfaceCosendError` can read the API's `code`
			// and `request_id` out of it. Safe only because that check runs first on every
			// declarative operation — `test/contract.test.ts` holds the two together.
			ignoreHttpStatusErrors: true,
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Automation', value: 'automation' },
					{ name: 'Contact', value: 'contact' },
					{ name: 'Conversation', value: 'conversation' },
					{ name: 'Message', value: 'message' },
					{ name: 'Notification', value: 'notification' },
					{ name: 'Schedule', value: 'schedule' },
					{ name: 'Usage', value: 'usage' },
					{ name: 'Workspace', value: 'me' },
				],
				default: 'message',
				// The Resource selector is the first property n8n's routing reads, so this check runs
				// before any operation's own `postReceive` — a refusal never reaches `rootProperty`.
				routing: { output: { postReceive: [surfaceCosendError] } },
			},
			...messageDescription,
			...conversationDescription,
			...contactDescription,
			...automationDescription,
			...usageDescription,
			...notificationDescription,
			...scheduleDescription,
			...meDescription,
		],
	};

	methods = {
		listSearch: {
			searchAutomations,
			searchConnections,
			searchContacts,
			searchConversations,
			searchTemplates,
		},
	};

	/**
	 * The operations routing cannot express: a binary attachment needs an upload first, a batch
	 * has to fold many items into one request and map a `207` back onto `pairedItem`, and an upsert
	 * writes the fields only after it learns whether the contact already existed.
	 *
	 * `execute` is deliberately absent — `n8n-workflow` documents these as mutually exclusive
	 * ("either `execute` or `customOperations` … but not both"), and keeping `execute` off the
	 * class is what keeps the node declarative for lint and light versioning (D2).
	 */
	customOperations = {
		message: {
			send: sendMessage,
			sendBatch,
		},
		contact: {
			upsert: upsertContact,
		},
	};
}
