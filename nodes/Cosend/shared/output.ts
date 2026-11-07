import type {
	IDataObject,
	IExecuteSingleFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

/**
 * n8n's UX guidelines, "Simplifying output fields": a response of more than 10 fields gets a
 * `Simplify` switch on a normal node, returning at most 10 fields, flattened, the most used first;
 * an AI tool node gets `Output` instead, with `Simplified`, `Raw` and `Selected Fields`, where the
 * selected fields always include the record's ID.
 *
 * One simplified shape per kind of record, kept to nine fields so the trigger can add `event` and
 * still return ten. The action node's Simplify, the tool's Output and the trigger's Simplify all
 * read these, so a message looks the same wherever it comes from.
 */
export type RecordKind = 'message' | 'conversation' | 'contact' | 'automation' | 'run' | 'runEvent';

const record = (value: unknown): IDataObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as IDataObject) : {};

const firstText = (...values: unknown[]): string | null => {
	for (const value of values) if (typeof value === 'string' && value !== '') return value;
	return null;
};

/** The words of a message, whatever its type: a text's body, a caption, a template's text. */
function messageText(message: IDataObject): string | null {
	const content = record(message.content);
	return firstText(
		record(content.text).body,
		content.body,
		content.caption,
		record(content[String(message.type)]).caption,
		message.template_text,
	);
}

const SIMPLIFY: Record<RecordKind, (item: IDataObject) => IDataObject> = {
	message: (m) => ({
		id: m.id ?? null,
		conversation_id: m.conversation_id ?? null,
		contact_id: m.contact_id ?? null,
		phone: record(m.contact).phone_e164 ?? null,
		direction: m.direction ?? null,
		type: m.type ?? null,
		text: messageText(m),
		status: m.status ?? null,
		created_at: m.created_at ?? null,
	}),
	conversation: (c) => ({
		id: c.id ?? null,
		contact_id: c.contact_id ?? null,
		contact_name: record(c.contact).display_name ?? null,
		phone: record(c.contact).phone_e164 ?? null,
		state: c.state ?? null,
		control: c.control ?? null,
		assignee_id: c.assignee_id ?? null,
		unread_count: c.unread_count ?? null,
		last_message_at: c.last_message_at ?? null,
	}),
	contact: (c) => ({
		id: c.id ?? null,
		display_name: c.display_name ?? null,
		phone_e164: c.phone_e164 ?? null,
		tags: c.tags ?? [],
		attributes: c.attributes ?? {},
		locale: c.locale ?? null,
		is_blocked: c.is_blocked ?? false,
		last_seen_at: c.last_seen_at ?? null,
		created_at: c.created_at ?? null,
	}),
	automation: (a) => ({
		id: a.id ?? null,
		name: a.name ?? null,
		status: a.status ?? null,
		trigger_kind: a.trigger_kind ?? null,
		connection_id: a.connection_id ?? null,
		can_run: a.can_run ?? null,
		last_run_at: a.last_run_at ?? null,
		runs_today: a.runs_today ?? null,
		failures_today: a.failures_today ?? null,
	}),
	run: (r) => ({
		id: r.id ?? null,
		automation_id: r.automation_id ?? null,
		automation_name: r.automation_name ?? null,
		status: r.status ?? null,
		skip_reason: r.skip_reason ?? null,
		started_at: r.started_at ?? null,
		finished_at: r.finished_at ?? null,
		duration_ms: r.duration_ms ?? null,
		error: firstText(record(r.error).message, r.error),
	}),
	runEvent: (e) => ({
		seq: e.seq ?? null,
		step_id: e.step_id ?? null,
		step_action: e.step_action ?? null,
		kind: e.kind ?? null,
		status: e.status ?? null,
		error: firstText(record(e.error).message, e.error),
		duration_ms: e.duration_ms ?? null,
		created_at: e.created_at ?? null,
	}),
};

/**
 * Every top-level field of each record, as `GET` returns it (cosend-api's generated OpenAPI), for
 * the tool's `Selected Fields`.
 */
export const RECORD_FIELDS: Record<RecordKind, string[]> = {
	message: [
		'id', 'object', 'conversation_id', 'contact_id', 'contact', 'connection_id', 'wamid', 'direction',
		'source', 'status', 'type', 'content', 'location', 'contact_cards', 'label', 'forwarded',
		'frequently_forwarded', 'tap', 'template_text', 'reply_to', 'reactions', 'metadata', 'created_at',
		'wa_timestamp', 'is_imported', 'media_state', 'media_expires_at', 'media', 'transcript',
		'client_token', 'author_user_id', 'automation_run_id', 'campaign_id', 'error_code', 'error_title',
		'error_detail',
	],
	conversation: [
		'id', 'object', 'connection_id', 'contact_id', 'state', 'control', 'assignee_id', 'unread_count',
		'message_count', 'last_message_at', 'snoozed_until', 'window', 'lock', 'waiting', 'needs_person',
		'priority', 'resolved_at', 'resolved_by', 'labels', 'created_at', 'contact', 'last_message',
		'connection', 'last_read_at',
	],
	contact: [
		'id', 'object', 'connection_id', 'portfolio_id', 'numbers', 'display_name', 'phone_e164', 'wa_id',
		'bsuid', 'username', 'name', 'profile_name', 'attributes', 'tags', 'locale', 'timezone',
		'is_blocked', 'removed_in_app_at', 'first_seen_at', 'last_seen_at', 'created_at',
	],
	automation: [
		'id', 'object', 'slug', 'name', 'description', 'status', 'trigger_kind', 'trigger_config',
		'connection_id', 'active_version_id', 'consecutive_failures', 'last_run_at', 'last_error',
		'auto_disabled_at', 'auto_disabled_reason', 'created_at', 'updated_at', 'can_run',
		'blocked_reason', 'activation', 'template_approval', 'active_version', 'latest_version',
		'settings', 'authoring_conversation_id', 'conflicts', 'sheets', 'warnings', 'runs_today',
		'failures_today', 'created_by',
	],
	run: [
		'id', 'object', 'automation_id', 'automation_name', 'connection_id', 'version_no', 'status',
		'skip_reason', 'trigger', 'started_at', 'finished_at', 'duration_ms', 'steps_failed', 'usage',
		'sent_messages', 'result', 'error', 'failed_step', 'failure', 'executor_error', 'test',
	],
	runEvent: [
		'seq', 'step_id', 'step_action', 'kind', 'status', 'error', 'would', 'decision', 'test_step',
		'duration_ms', 'created_at',
	],
};

/** The field that identifies each record, which `Selected Fields` always keeps. */
const ID_FIELD: Record<RecordKind, string> = {
	message: 'id',
	conversation: 'id',
	contact: 'id',
	automation: 'id',
	run: 'id',
	runEvent: 'seq',
};

export function simplifyRecord(kind: RecordKind, item: IDataObject): IDataObject {
	return SIMPLIFY[kind](item);
}

export function selectFields(kind: RecordKind, item: IDataObject, fields: string[]): IDataObject {
	const keep = [ID_FIELD[kind], ...fields.filter((field) => field !== ID_FIELD[kind])];
	return Object.fromEntries(keep.filter((field) => field in item).map((field) => [field, item[field]]));
}

/** The kind of record a webhook event carries, by its `object`, for the trigger's Simplify. */
export function recordKindOf(item: IDataObject): RecordKind | undefined {
	const object = item.object;
	if (object === 'message' || object === 'conversation' || object === 'contact') return object;
	if (object === 'automation') return 'automation';
	if (object === 'run' || object === 'automation_run') return 'run';
	return undefined;
}

/** Which kind of record each operation returns, for the shaping below. */
const KIND_OF: Record<string, RecordKind> = {
	'message:get': 'message',
	'message:getAll': 'message',
	'conversation:get': 'conversation',
	'conversation:getAll': 'conversation',
	'contact:get': 'contact',
	'contact:getAll': 'contact',
	'automation:getAll': 'automation',
	'automation:getRun': 'run',
	'automation:getRunEvents': 'runEvent',
};

/**
 * The records an operation returned, shaped as `Simplify` or `Output` asks. Runs after the list is
 * unwrapped, and leaves a refusal's item as it is so its `code` and `request_id` survive.
 */
async function shapeOutput(
	this: IExecuteSingleFunctions,
	items: INodeExecutionData[],
	response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	if (response.statusCode >= 400) return items;
	const resource = this.getNodeParameter('resource') as string;
	const operation = this.getNodeParameter('operation') as string;
	const kind = KIND_OF[`${resource}:${operation}`];
	if (kind === undefined) return items;

	const isTool = this.getNode().type.endsWith('Tool');
	const mode = isTool
		? (this.getNodeParameter('output', 'simplified') as string)
		: this.getNodeParameter('simplify', true) === true
			? 'simplified'
			: 'raw';
	if (mode === 'raw') return items;
	const fields = mode === 'selected' ? (this.getNodeParameter('fields', []) as string[]) : [];
	return items.map((item) => ({
		...item,
		json:
			mode === 'selected'
				? selectFields(kind, item.json, fields)
				: simplifyRecord(kind, item.json),
	}));
}

const fromVersion11 = { '@version': [{ _cnd: { gte: 1.1 } }] };

/** A field as a dropdown names it: `conversation_id` reads "Conversation ID". */
const fieldName = (field: string) =>
	field
		.split('_')
		.map((word) => (word === 'id' ? 'ID' : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
		.join(' ');

/**
 * `Simplify` on the node, `Output` and `Selected Fields` on its AI tool form, for the operations
 * in `show`. From version 1.1, so a workflow built on version 1 keeps the raw records it was
 * built against.
 */
export function outputProperties(show: Record<string, string[]>, kind: RecordKind): INodeProperties[] {
	return [
		{
			displayName: 'Simplify',
			name: 'simplify',
			type: 'boolean',
			default: true,
			description: 'Whether to return a simplified version of the response instead of the raw data',
			displayOptions: { show: { ...show, ...fromVersion11, '@tool': [false] } },
			routing: { output: { postReceive: [shapeOutput] } },
		},
		{
			displayName: 'Output',
			name: 'output',
			type: 'options',
			default: 'simplified',
			options: [
				{
					name: 'Simplified',
					value: 'simplified',
					description: 'The most useful fields, at most ten',
				},
				{ name: 'Raw', value: 'raw', description: 'Every field' },
				{
					name: 'Selected Fields',
					value: 'selected',
					description: 'Only the fields you pick, plus the ID',
				},
			],
			displayOptions: { show: { ...show, ...fromVersion11, '@tool': [true] } },
			routing: { output: { postReceive: [shapeOutput] } },
		},
		{
			displayName: 'Fields',
			name: 'fields',
			type: 'multiOptions',
			default: [],
			description: 'The fields to return. The ID is always included.',
			options: RECORD_FIELDS[kind]
				.filter((field) => field !== ID_FIELD[kind])
				.map((field) => ({ name: fieldName(field), value: field }))
				.sort((a, b) => a.name.localeCompare(b.name)),
			displayOptions: {
				show: { ...show, ...fromVersion11, '@tool': [true], output: ['selected'] },
			},
		},
	];
}
