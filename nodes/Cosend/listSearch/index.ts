import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
} from 'n8n-workflow';

import { cosendApiRequest, type CosendListResponse, MAX_PAGE_SIZE } from '../shared/transport';

/**
 * One page of a Cosend list, turned into the shape n8n's "From list" picker wants.
 *
 * The `paginationToken` passthrough is A2 §3.2's `after` cursor. n8n hands the token it was last
 * given straight back on the next call, so this is a relay and not a cursor this code interprets —
 * which is exactly what A2 means by "opaque to clients by contract".
 */
async function page<T>(
	context: ILoadOptionsFunctions,
	endpoint: string,
	paginationToken: string | undefined,
	query: IDataObject,
	toItem: (record: T) => INodeListSearchItems,
	matches?: (record: T, filter: string) => boolean,
	filter?: string,
): Promise<INodeListSearchResult> {
	const qs: IDataObject = { ...query, limit: MAX_PAGE_SIZE };
	if (paginationToken !== undefined && paginationToken !== '') qs.after = paginationToken;

	const response = (await cosendApiRequest.call(
		context,
		'GET',
		endpoint,
		undefined,
		qs,
	)) as unknown as CosendListResponse<T>;

	const wanted =
		matches === undefined || filter === undefined || filter === ''
			? response.data
			: response.data.filter((record) => matches(record, filter.toLowerCase()));

	return {
		results: wanted.map(toItem),
		...(response.has_more === true && response.next_cursor !== null
			? { paginationToken: response.next_cursor }
			: {}),
	};
}

interface ContactRecord {
	id: string;
	display_name: string;
	wa_id: string | null;
}

/**
 * `GET /v1/contacts?q=` — the **only** picker here whose filtering happens server-side, because
 * it is the only list endpoint that takes a free-text parameter (A2 §5.6: "`q` searches
 * display_name").
 */
export async function searchContacts(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return page<ContactRecord>(
		this,
		'/contacts',
		paginationToken,
		filter === undefined || filter === '' ? {} : { q: filter },
		(contact) => ({
			name:
				contact.wa_id === null
					? contact.display_name
					: `${contact.display_name} (${contact.wa_id})`,
			value: contact.id,
		}),
	);
}

interface ConversationRecord {
	id: string;
	state: string;
	last_message_at: string | null;
	contact: { display_name: string; wa_id: string | null } | null;
}

/**
 * `GET /v1/conversations?expand=contact`.
 *
 * **Filtered in this function, not by the API.** A2 §5.5's list takes `state`, `control`,
 * `assignee_id`, `connection_id`, `label` and `unread` — and no free-text parameter. Sending `q`
 * would be silently ignored and the picker would look broken for a search that returned the whole
 * first page. Named in the handoff as a gap worth closing in the API rather than worked around
 * more cleverly here.
 */
export async function searchConversations(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return page<ConversationRecord>(
		this,
		'/conversations',
		paginationToken,
		{ expand: 'contact' },
		(conversation) => {
			const who = conversation.contact?.display_name ?? conversation.id;
			return {
				name: `${who} — ${conversation.state}`,
				value: conversation.id,
			};
		},
		(conversation, needle) =>
			`${conversation.contact?.display_name ?? ''} ${conversation.contact?.wa_id ?? ''} ${conversation.id}`
				.toLowerCase()
				.includes(needle),
		filter,
	);
}

interface TemplateRecord {
	name: string;
	language: string;
	status: string;
	sendable: boolean;
}

/**
 * `GET /v1/templates`, filtered in this function for the same reason as conversations.
 *
 * **Templates that are not sendable are listed, with their status in the label.** Hiding them
 * would be worse: a template awaiting Meta's approval today is the one the workflow is being
 * built for, and a picker that silently omits it reads as "Cosend lost my template". Showing
 * `— PENDING` tells the truth without deciding for the user (standing rule 10).
 */
export async function searchTemplates(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return page<TemplateRecord>(
		this,
		'/templates',
		paginationToken,
		{},
		(template) => ({
			name: template.sendable
				? `${template.name} (${template.language})`
				: `${template.name} (${template.language}) — ${template.status}`,
			value: template.name,
			description: template.sendable
				? undefined
				: `Meta has not approved this template yet, so sending it now fails with template_not_approved`,
		}),
		(template, needle) => `${template.name} ${template.language}`.toLowerCase().includes(needle),
		filter,
	);
}

interface AutomationRecord {
	id: string;
	name: string;
	status: string;
}

/** A1 §1.4's `automation_status`, in the words the label shows. `enabled` needs none. */
const AUTOMATION_STATE: Record<string, string> = {
	draft: 'draft',
	disabled: 'switched off',
	archived: 'archived',
	auto_disabled: 'switched off',
};

/**
 * `GET /v1/automations`, filtered in this function — it takes no free-text parameter.
 *
 * **Switched-off automations are listed, with their state in the label**, for the same reason
 * templates are: hiding one reads as "Cosend lost it", and the picker is not the place to decide
 * what the workflow may start.
 */
export async function searchAutomations(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return page<AutomationRecord>(
		this,
		'/automations',
		paginationToken,
		{},
		(automation) => {
			const state = AUTOMATION_STATE[automation.status];
			return {
				name: state === undefined ? automation.name : `${automation.name} (${state})`,
				value: automation.id,
			};
		},
		(automation, needle) => automation.name.toLowerCase().includes(needle),
		filter,
	);
}

interface ConnectionRecord {
	id: string;
	display_phone_number: string;
	verified_name: string | null;
	mode: string;
	status: string;
}

/** `GET /v1/connections`, filtered in this function — it takes no free-text parameter either. */
export async function searchConnections(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return page<ConnectionRecord>(
		this,
		'/connections',
		paginationToken,
		{},
		(connection) => ({
			name:
				connection.verified_name === null
					? connection.display_phone_number
					: `${connection.verified_name} (${connection.display_phone_number})`,
			value: connection.id,
			description: `${connection.mode === 'coexistence' ? 'Coexistence' : 'Cloud API'} · ${connection.status}`,
		}),
		(connection, needle) =>
			`${connection.verified_name ?? ''} ${connection.display_phone_number}`
				.toLowerCase()
				.includes(needle),
		filter,
	);
}
