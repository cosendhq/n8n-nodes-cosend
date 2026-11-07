import type { INodeProperties } from 'n8n-workflow';

import {
	connectionLocator,
	conversationLocator,
	paginationProperties,
	unwrapData,
} from '../shared/descriptions';
import { outputProperties } from '../shared/output';

const show = { resource: ['conversation'] };
const on = (...operations: string[]) => ({ ...show, operation: operations });

/**
 * A2 §5.5 — conversations.
 *
 * **No Create and no Close.** A conversation exists because a message exists; creating an empty
 * one has no meaning in WhatsApp and A2 has no such endpoint. "Close" is Update with
 * `State: Resolved` — modelling it separately would put two ways to do one thing in the UI.
 */
export const conversationDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Add Note',
				value: 'addNote',
				action: 'Add note to conversation',
				description:
					'Attach an internal note. Notes are visible to your team in the Cosend inbox and are never sent to the contact.',
				routing: {
					request: { method: 'POST', url: '=/conversations/{{ $parameter.conversationId }}/notes' },
				},
			},
			{
				name: 'Delete Note',
				value: 'deleteNote',
				action: 'Delete note from conversation',
				description:
					'Delete an internal note from a conversation. Its author, or an owner or admin, can do this.',
				routing: {
					request: {
						method: 'DELETE',
						url: '=/conversations/{{ $parameter.conversationId }}/notes/{{ $parameter.noteId }}',
					},
				},
			},
			{
				name: 'Update Note',
				value: 'editNote',
				action: 'Update note on conversation',
				description:
					'Update the text of an internal note on a conversation. Its author can do this; the people it mentions stay the same.',
				routing: {
					request: {
						method: 'PATCH',
						url: '=/conversations/{{ $parameter.conversationId }}/notes/{{ $parameter.noteId }}',
					},
				},
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get conversation',
				description: 'Retrieve one conversation with its messaging window and lock state',
				routing: {
					request: { method: 'GET', url: '=/conversations/{{ $parameter.conversationId }}' },
				},
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many conversations',
				description: 'Retrieve a list of conversations',
				routing: { request: { method: 'GET', url: '/conversations' }, ...unwrapData },
			},
			{
				name: 'Mark as Read',
				value: 'markRead',
				action: 'Mark conversation as read',
				description:
					'Mark a conversation as read in the Cosend inbox, for your team. Blue ticks on the contact’s phone come from Message: Mark as Read.',
				routing: {
					request: { method: 'POST', url: '=/conversations/{{ $parameter.conversationId }}/read' },
				},
			},
			{
				name: 'Set Control',
				value: 'setControl',
				action: 'Set control of conversation',
				description: 'Pass a conversation from the assistant to a person on your team',
				routing: {
					request: {
						method: 'POST',
						url: '=/conversations/{{ $parameter.conversationId }}/control',
					},
				},
			},
			{
				name: 'Update',
				value: 'update',
				action: 'Update conversation',
				description: 'Update a conversation’s state, assignee, labels or snooze time',
				routing: {
					request: { method: 'PATCH', url: '=/conversations/{{ $parameter.conversationId }}' },
				},
			},
		],
		default: 'getAll',
	},

	{
		...conversationLocator('The conversation to act on'),
		displayOptions: {
			show: on('get', 'update', 'setControl', 'markRead', 'addNote', 'editNote', 'deleteNote'),
		},
	},

	// ── setControl ────────────────────────────────────────────────────────────────────────────
	{
		displayName: 'Control',
		name: 'control',
		type: 'options',
		required: true,
		default: 'human',
		description: 'Who answers this conversation from now on',
		displayOptions: { show: on('setControl') },
		/**
		 * **TWO VALUES, AND BOTH OMISSIONS ARE DELIBERATE.**
		 *
		 * `app` is refused by A2 with `400 control_app_is_observed`: it is the coexistence state
		 * meaning the owner is replying from their own phone, and Cosend records it rather than
		 * accepting it. "That column is a fact about the world, not a setting."
		 *
		 * `bot` is refused because handover is **one-way**. Standing rule 3, from decision C9:
		 * *"A human cannot send something to an AI through a click. It's one way."* The API's
		 * `settableControl` enum is `pending_human | human` and carries no `bot`, so a Bot entry
		 * here would be a dropdown option that 400s — and the product rule it would break is the
		 * one Ramee stated in his own words.
		 *
		 * Doc 03 §4.3 lists `Bot / Pending Human / Human`. It is wrong on both counts.
		 */
		options: [
			{
				name: 'Human',
				value: 'human',
				description: 'A person on your team is answering now, and the assistant stays quiet',
			},
			{
				name: 'Passed to a Person',
				value: 'pending_human',
				description: 'The conversation waits in the inbox for a person on your team',
			},
		],
		routing: { send: { type: 'body', property: 'control' } },
	},
	{
		displayName: 'Control Options',
		name: 'controlOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: on('setControl') },
		options: [
			{
				displayName: 'Pause Assistant Until',
				name: 'pauseBotUntil',
				type: 'dateTime',
				default: '',
				description: 'When the assistant may answer again. Leave empty to keep the conversation with your team.',
				routing: { send: { type: 'body', property: 'pause_bot_until' } },
			},
			{
				displayName: 'Reason',
				name: 'reason',
				type: 'string',
				default: '',
				placeholder: 'e.g. customer asked for a person',
				description: 'Why control changed, recorded on the conversation for your team to read',
				routing: { send: { type: 'body', property: 'reason' } },
			},
		],
	},

	// ── addNote, editNote, deleteNote ─────────────────────────────────────────────────────────
	{
		displayName: 'Note ID',
		name: 'noteId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. note_01J9Z3K8M2Q4R6T8V0W2X4Y6Z8',
		description: "The note to change. 'Add Note' returns its ID.",
		displayOptions: { show: on('editNote', 'deleteNote') },
	},
	{
		displayName: 'Note',
		name: 'noteBody',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		required: true,
		description: 'The note text. Your team sees this in the inbox; the contact never does.',
		displayOptions: { show: on('addNote', 'editNote') },
		routing: { send: { type: 'body', property: 'body' } },
	},
	{
		displayName: 'Mentions',
		name: 'mentions',
		type: 'string',
		default: '',
		placeholder: 'e.g. usr_01J9Z3K8M2Q4R6T8V0W2X4Y6Z8',
		description:
			'Comma-separated user IDs of team members to notify about this note. Leave empty to notify nobody.',
		displayOptions: { show: on('addNote') },
		routing: {
			send: {
				type: 'body',
				property: 'mentions',
				value: '={{ $value.split(",").map(m => m.trim()).filter(m => m) }}',
			},
		},
	},

	// ── update ────────────────────────────────────────────────────────────────────────────────
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: on('update') },
		options: [
			{
				displayName: 'Assignee ID',
				name: 'assigneeId',
				type: 'string',
				default: '',
				placeholder: 'e.g. usr_01J9Z3K8M2Q4R6T8V0W2X4Y6Z8',
				description:
					'The user ID of the team member who owns this conversation. Leave it empty to unassign.',
				routing: { send: { type: 'body', property: 'assignee_id' } },
			},
			{
				displayName: 'Labels',
				name: 'labels',
				type: 'string',
				default: '',
				placeholder: 'e.g. refund,urgent',
				description:
					'Comma-separated labels. These become the conversation’s labels, in place of the ones it has.',
				routing: {
					send: {
						type: 'body',
						property: 'labels',
						value: '={{ $value.split(",").map(l => l.trim()).filter(l => l) }}',
					},
				},
			},
			{
				displayName: 'Snoozed Until',
				name: 'snoozedUntil',
				type: 'dateTime',
				default: '',
				description:
					"When a snoozed conversation returns to the inbox. Used with 'State' set to 'Snoozed'.",
				routing: { send: { type: 'body', property: 'snoozed_until' } },
			},
			{
				displayName: 'State',
				name: 'state',
				type: 'options',
				default: 'resolved',
				description: 'Where this conversation sits in your inbox',
				options: [
					{ name: 'Open', value: 'open', description: 'Waiting for your team to answer' },
					{
						name: 'Pending',
						value: 'pending',
						description: 'Answered, waiting on the contact to reply',
					},
					{
						name: 'Resolved',
						value: 'resolved',
						description: 'Finished. This is how you close a conversation.',
					},
					{
						name: 'Snoozed',
						value: 'snoozed',
						description: "Hidden until the time in 'Snoozed Until'",
					},
				],
				routing: { send: { type: 'body', property: 'state' } },
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
				displayName: 'Assignee ID',
				name: 'assigneeId',
				type: 'string',
				default: '',
				placeholder: 'e.g. usr_01J9Z3K8M2Q4R6T8V0W2X4Y6Z8',
				description: 'Only return conversations owned by this team member, by user ID',
				routing: { send: { type: 'query', property: 'assignee_id' } },
			},
			{
				...connectionLocator({
					required: false,
					description: 'Only return conversations on this WhatsApp number',
				}),
				routing: { send: { type: 'query', property: 'connection_id' } },
			},
			{
				displayName: 'Control',
				name: 'control',
				type: 'options',
				default: 'human',
				// **`App` IS OFFERED HERE AND NOT ON SET CONTROL.** Filtering by it is exactly how a
				// workflow finds the conversations the owner is handling from their phone, which is
				// the coexistence case the product exists for. Only *setting* it is refused.
				description: 'Only return conversations under this kind of control',
				options: [
					{ name: 'Assistant', value: 'bot', description: 'The assistant is answering' },
					{ name: 'Human', value: 'human', description: 'A person on your team is answering' },
					{
						name: 'On Phone',
						value: 'app',
						description: 'The owner is replying from the WhatsApp Business app on their phone',
					},
					{
						name: 'Passed to a Person',
						value: 'pending_human',
						description: 'Waiting in the inbox for a person on your team',
					},
				],
				routing: { send: { type: 'query', property: 'control' } },
			},
			{
				displayName: 'Label',
				name: 'label',
				type: 'string',
				default: '',
				description: 'Only return conversations carrying this label',
				routing: { send: { type: 'query', property: 'label' } },
			},
			{
				displayName: 'State',
				name: 'state',
				type: 'options',
				default: 'open',
				description: 'Only return conversations in this state',
				options: [
					{ name: 'Open', value: 'open' },
					{ name: 'Pending', value: 'pending' },
					{ name: 'Resolved', value: 'resolved' },
					{ name: 'Snoozed', value: 'snoozed' },
				],
				routing: { send: { type: 'query', property: 'state' } },
			},
			{
				displayName: 'Unread Only',
				name: 'unread',
				type: 'boolean',
				default: true,
				description: 'Whether to return only conversations with unread messages',
				routing: { send: { type: 'query', property: 'unread' } },
			},
		],
	},

	// ── get, getAll: Simplify, or the tool's Output ───────────────────────────────────────────
	...outputProperties(on('get', 'getAll'), 'conversation'),
];
