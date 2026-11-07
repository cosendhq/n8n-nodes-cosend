import { randomUUID } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IExecuteSingleFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INode,
	INodeExecutionData,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export type CosendContext =
	| IExecuteFunctions
	| IExecuteSingleFunctions
	| ILoadOptionsFunctions
	| IHookFunctions
	| IWebhookFunctions;

/** A2 §3.2's list envelope. `after` is the cursor parameter — NOT `cursor`. */
export interface CosendListResponse<T> {
	data: T[];
	has_more: boolean;
	next_cursor: string | null;
}

export const DEFAULT_BASE_URL = 'https://api.cosend.app/v1';

/** A2 §3.2: "limit default 25, max 100". The API clamps rather than rejecting; we never exceed it. */
export const MAX_PAGE_SIZE = 100;

/**
 * What a failed Cosend request says about itself, out of A2 §3.4's error body
 * `{ error: { type, code, message, request_id, docs, … } }`.
 *
 * `code` is the stable identifier the error reference at cosend.app/docs/errors lists, and
 * `request_id` is the one to quote to support — cosend.app/docs/n8n promises both reach a failed
 * node's output. `message` is the API's own words for what happened.
 */
export interface CosendFailure {
	message?: string;
	code?: string;
	request_id?: string;
}

const textAt = (record: Record<string, unknown>, key: string): string | undefined =>
	typeof record[key] === 'string' ? (record[key] as string) : undefined;

/** The `error` member of an A2 §3.4 body, field by field, ignoring anything not a string. */
export function cosendFailureOf(body: unknown): CosendFailure {
	if (typeof body !== 'object' || body === null) return {};
	const error = (body as { error?: unknown }).error;
	if (typeof error !== 'object' || error === null) return {};
	const record = error as Record<string, unknown>;
	const failure: CosendFailure = {};
	const message = textAt(record, 'message');
	const code = textAt(record, 'code');
	const requestId = textAt(record, 'request_id');
	if (message !== undefined) failure.message = message;
	if (code !== undefined) failure.code = code;
	if (requestId !== undefined) failure.request_id = requestId;
	return failure;
}

/**
 * The HTTP error underneath what `httpRequestWithAuthentication` threw.
 *
 * **n8n-core does not throw the HTTP error itself.** Read from n8n-core 2.16.1's
 * `request-helper-functions.js`: it catches axios's `AxiosError` and throws
 * `new NodeApiError(node, error)`. Newer n8n-workflow keeps the `AxiosError` as that error's
 * `cause`; on n8n-workflow 2.16.x `cause` is undefined, and the `NodeApiError` itself is all
 * there is.
 */
function httpErrorOf(error: unknown): unknown {
	return error instanceof NodeApiError && error.cause !== undefined ? error.cause : error;
}

/**
 * The response body of a refused request.
 *
 * `context.data` first: `NodeApiError` copies axios's `response.data` there in every n8n-workflow
 * version, while `cause` exists only on newer ones. Reading `error.response.body` — what this
 * package once did — found nothing in a real n8n, which is how Send's error output went out
 * without its `code`.
 */
function responseBodyOf(error: unknown): unknown {
	if (error instanceof NodeApiError && error.context.data !== undefined) return error.context.data;
	const httpError = httpErrorOf(error);
	if (typeof httpError !== 'object' || httpError === null) return undefined;
	const response = (httpError as { response?: unknown }).response;
	if (typeof response !== 'object' || response === null) return undefined;
	return (response as { data?: unknown }).data;
}

/**
 * Cosend error code → a message shaped the way n8n's UX guidelines ask: what happened, which
 * parameter, and what to do next.
 *
 * **Every key here is a real code from the API's own catalogue** (`src/core/errors/catalogue.ts`).
 * Doc 03 §5.6's draft mapped `outside_24h_window` and `number_not_registered`, and neither code
 * exists — a mapping keyed on a code the API never sends is a branch that can never run
 * (standing rule 9) and a description that lies to whoever reads it (standing rule 10).
 */
const EXPLANATIONS: Record<string, string> = {
	service_window_closed:
		"This contact hasn't messaged you in the last 24 hours, so WhatsApp only allows an approved template. Set 'Message Type' to 'Template', or set 'Send Mode' to 'Auto' and name a fallback template.",
	template_not_approved:
		"This template needs Meta's approval before it sends. Check its status in Cosend under Templates, and send free-form text instead while the window is open.",
	template_not_found:
		"Check 'Template Name' and 'Language', or sync templates in Cosend under Templates. This WhatsApp number has no template with that name and language.",
	recipient_opted_out:
		'This contact has opted out of messages from you. WhatsApp does not allow sending to them until they message you again.',
	connection_not_active:
		"Reconnect this WhatsApp number in the Cosend dashboard under Numbers, then run the workflow again.",
	connection_not_found:
		"Pick a WhatsApp number from the list in 'WhatsApp Number'. The ID given is not one of this workspace's numbers.",
	connection_not_routable:
		"Use a workspace key, or the connection key of this WhatsApp number. A connection key sends from its own number only.",
	conversation_locked:
		'Another team member holds this conversation. Wait for them to release it, or request control from the Cosend inbox.',
	control_app_is_observed:
		"Cosend sets 'On Phone' itself when the owner replies from their phone. Choose 'Human' or 'Passed to a Person'.",
	media_too_large:
		"This file is larger than WhatsApp allows for its type. WhatsApp's limits are 5 MB for images, 16 MB for audio and video, 100 MB for documents and 500 KB for stickers.",
	media_unavailable:
		'Cosend could not read that media. Check the media ID or the URL is reachable.',
	recurring_schedules_not_available:
		'Use an anchored schedule: one appointment time plus a ladder of reminder offsets.',
	throughput_exceeded:
		'This WhatsApp number is sending at its maximum rate. Cosend paces sends per number; lower the workflow rate or send in a batch.',
	rate_limited:
		'Too many requests. Wait for the period given by the Retry-After header and try again.',
	idempotency_key_required:
		"This endpoint needs an 'Idempotency Key'. The node normally supplies one. Set it under 'Options' if you cleared it.",
	idempotency_key_reuse:
		"This 'Idempotency Key' was already used with a different request body. Use a new key, or send the identical body again to get the original result.",
	insufficient_scope:
		"This API key doesn't carry the scope this operation needs. Create a key with it in Cosend under Settings → API Keys.",
	recipient_invalid:
		"Use a phone number with + and the country code, for example '+919876543210', or a contact ID starting with 'ct_'.",
};

/** The friendlier text for a Cosend error code, or `undefined` when we have nothing better to say. */
export function explainCosendError(code: string | undefined): string | undefined {
	return code === undefined ? undefined : EXPLANATIONS[code];
}

/**
 * The node error for a request Cosend refused.
 *
 * The message is the API's own words and the description the explanation above, so the text a
 * person reads stays plain; `code` and `request_id` ride in the error's `context`, which is data an
 * error workflow can read (`$execution.error.context`) without either appearing in a sentence.
 */
export function cosendApiError(
	node: INode,
	errorResponse: JsonObject,
	failure: CosendFailure,
	options: { fallbackMessage: string; httpCode?: string; itemIndex?: number },
): NodeApiError {
	// n8n's UX guidelines: a message about one item ends with `[item X]`.
	const item = options.itemIndex === undefined ? '' : ` [item ${options.itemIndex}]`;
	const error = new NodeApiError(node, errorResponse, {
		message: `${failure.message ?? options.fallbackMessage}${item}`,
		...(options.httpCode === undefined ? {} : { httpCode: options.httpCode }),
		...(options.itemIndex === undefined ? {} : { itemIndex: options.itemIndex }),
	});
	// Handed an existing `NodeApiError` (n8n-workflow 2.16.x's, which has no `cause`), the
	// constructor returns it unchanged and ignores `message`, so n8n's generic one would stay. With
	// no Cosend message to put there (a refused connection, a proxy's page), n8n's own is kept.
	if (errorResponse instanceof NodeApiError && failure.message !== undefined) {
		error.message = `${failure.message}${item}`;
		// n8n made the description from that same body, and drops it as a repeat only when it builds
		// the error itself.
		if (error.description === failure.message) error.description = undefined;
	}
	// Set after, not passed in: given an HTTP error whose body has `error.message`, the constructor
	// replaces the description it was handed with that message, then clears it as a repeat of the
	// error's own message — so the explanation would never be shown.
	const description = explainCosendError(failure.code);
	if (description !== undefined) error.description = description;
	if (failure.code !== undefined) error.context.code = failure.code;
	if (failure.request_id !== undefined) error.context.request_id = failure.request_id;
	return error;
}

/**
 * The output item for a failure under "On Error → Continue": what happened, plus the `code` and
 * `request_id` cosend.app/docs/n8n promises a failed node's output carries. The same shape for a
 * declarative operation, a custom one and a batch row, so a workflow branching on `code` reads one
 * field wherever the failure came from.
 */
export function failureJson(message: string, failure: CosendFailure): IDataObject {
	const hint = explainCosendError(failure.code);
	return {
		error: message,
		...(failure.code === undefined ? {} : { code: failure.code }),
		...(failure.request_id === undefined ? {} : { request_id: failure.request_id }),
		...(hint === undefined ? {} : { hint }),
	};
}

/** `failureJson` for a thrown error: a `cosendApiError` carries its code in `context`. */
export function failureJsonOf(error: unknown): IDataObject {
	const context = (error as { context?: IDataObject }).context ?? {};
	const failure: CosendFailure = {};
	if (typeof context.code === 'string') failure.code = context.code;
	if (typeof context.request_id === 'string') failure.request_id = context.request_id;
	return failureJson((error as Error).message, failure);
}

/**
 * A thrown error about one item, its message ending `[item X]` as n8n's UX guidelines ask. An
 * error that is not yet n8n's own is wrapped so the item index travels with it.
 */
export function withItem(node: INode, error: unknown, itemIndex: number): NodeApiError | NodeOperationError {
	const nodeError =
		error instanceof NodeApiError || error instanceof NodeOperationError
			? error
			: new NodeApiError(node, error as JsonObject, { itemIndex });
	const suffix = ` [item ${itemIndex}]`;
	if (!nodeError.message.endsWith(suffix)) nodeError.message = `${nodeError.message}${suffix}`;
	return nodeError;
}

/**
 * The output item for a failure under "On Error → Continue".
 *
 * **Under "Continue (using error output)" the code, request ID and hint move into `details`.**
 * n8n sends an item to the error output when the item carries `error`, or when its JSON holds
 * nothing but `error`, `message` and `details` (n8n-core's `handleNodeErrorOutput`). The first is
 * no use here: n8n 2.46 then replaces the item's JSON with `{ error: message }`
 * (`normalizeNodeErrors`), and the code and request ID are gone. So the JSON takes the second
 * shape, and n8n adds the input item's own fields to it. Under plain "Continue" the JSON stays
 * flat, as it always was.
 */
export function failureItem(node: INode, json: IDataObject, itemIndex?: number): INodeExecutionData {
	const { error, ...details } = json;
	const shaped = node.onError === 'continueErrorOutput' ? { error, details } : json;
	return itemIndex === undefined ? { json: shaped } : { json: shaped, pairedItem: { item: itemIndex } };
}

/**
 * A declarative operation's answer, checked before anything else reads it.
 *
 * The node's `requestDefaults` set `ignoreHttpStatusErrors`, so a refusal reaches this function as
 * a response rather than as n8n's generic HTTP error — which carries neither the API's `code` nor
 * its `request_id` where a workflow can read them. It is the first `postReceive` of every
 * declarative operation (it sits on the Resource selector, which n8n's routing reads first), so a
 * 4xx or 5xx never comes out looking like data. Under "On Error → Continue" the item it returns
 * still passes through a list's `unwrapList`, which leaves a refusal's item as it is.
 */
export async function surfaceCosendError(
	this: IExecuteSingleFunctions,
	items: INodeExecutionData[],
	response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	if (response.statusCode < 400) return items;

	const failure = cosendFailureOf(response.body);
	const fallbackMessage = `Cosend refused the request (HTTP ${response.statusCode})`;
	this.logger.warn('Cosend refused a request', {
		status: response.statusCode,
		code: failure.code,
		request_id: failure.request_id,
		itemIndex: this.getItemIndex(),
	});

	if (this.continueOnFail()) {
		return [failureItem(this.getNode(), failureJson(failure.message ?? fallbackMessage, failure))];
	}
	throw cosendApiError(this.getNode(), (response.body ?? {}) as JsonObject, failure, {
		fallbackMessage,
		httpCode: String(response.statusCode),
		itemIndex: this.getItemIndex(),
	});
}

/**
 * The single entry point for every hand-written HTTP call in this package.
 *
 * `httpRequestWithAuthentication` rather than `httpRequest`: n8n owns the credential, this code
 * never sees it, and `no-http-request-with-manual-auth` is satisfied structurally rather than by
 * remembering.
 */
export async function cosendApiRequest<T = IDataObject>(
	this: CosendContext,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject | undefined = undefined,
	qs: IDataObject = {},
	overrides: Partial<IHttpRequestOptions> = {},
): Promise<T> {
	const credentials = await this.getCredentials('cosendApi');
	const baseUrl = String(credentials.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${endpoint}`,
		headers: { Accept: 'application/json' },
		json: true,
		...overrides,
	};

	if (body !== undefined) options.body = body;
	if (Object.keys(qs).length > 0) options.qs = qs;

	try {
		return (await this.helpers.httpRequestWithAuthentication.call(this, 'cosendApi', options)) as T;
	} catch (error) {
		// Built from the HTTP error where there is one, not from n8n's `NodeApiError` around it. From
		// the `AxiosError` it still finds the HTTP status, which the trigger's `delete` reads as
		// `httpCode` to tell "already gone" from a real failure; without one, the `NodeApiError`
		// already carries that status.
		throw cosendApiError(
			this.getNode(),
			httpErrorOf(error) as JsonObject,
			cosendFailureOf(responseBodyOf(error)),
			{ fallbackMessage: 'Cosend could not complete the request' },
		);
	}
}

/**
 * Walk A2 §3.2's cursor pagination until it is exhausted, or until `limit` records are collected.
 *
 * **`after`, and `has_more`.** Doc 03 §5.6's draft used `?cursor=` and stopped on a null
 * `next_cursor`; §4.6 corrects the parameter name against A2 and the API's own
 * `parsePageRequest` only reads `after`/`before`. A `cursor` query parameter is silently ignored,
 * so the draft would have re-fetched page one until the record count stopped growing.
 */
export async function cosendApiRequestAllItems<T = IDataObject>(
	this: CosendContext,
	endpoint: string,
	qs: IDataObject = {},
	limit?: number,
): Promise<T[]> {
	const results: T[] = [];
	let after: string | null = null;

	for (;;) {
		const query: IDataObject = { ...qs, limit: MAX_PAGE_SIZE };
		if (after !== null) query.after = after;

		const page = (await cosendApiRequest.call(
			this,
			'GET',
			endpoint,
			undefined,
			query,
		)) as unknown as CosendListResponse<T>;

		results.push(...page.data);
		if (limit !== undefined && results.length >= limit) return results.slice(0, limit);
		if (page.has_more !== true || page.next_cursor === null) return results;
		after = page.next_cursor;
	}
}

/**
 * A2 §3.3 — `Idempotency-Key` is **required** on `POST /v1/messages`, `/messages/batch`,
 * `/messages/{id}/reactions`, `/notifications` and `/schedules`. Without it the API answers
 * `400 idempotency_key_required`, so this is not a nicety: an operation that omits the header
 * fails one hundred per cent of the time.
 *
 * A `preSend` action rather than a routing expression, because the key has to be *generated*
 * and n8n expressions cannot mint a UUID. Keeping it here also keeps the operation declarative:
 * `execute()` stays off the node class (D2).
 *
 * `randomUUID` comes from `crypto`, which is on the verified import allowlist.
 */
export async function attachIdempotencyKey(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const options = this.getNodeParameter('options', {}) as IDataObject;
	const supplied = typeof options.idempotencyKey === 'string' ? options.idempotencyKey.trim() : '';

	requestOptions.headers = {
		...requestOptions.headers,
		'Idempotency-Key': supplied.length > 0 ? supplied : randomUUID(),
	};
	return requestOptions;
}
