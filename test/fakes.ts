import type { IDataObject, IHttpRequestOptions, INode, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

/**
 * Just enough of n8n's execution contexts to drive the trigger.
 *
 * Deliberately hand-written rather than mocked wholesale: the tests that matter here assert on
 * the exact HTTP request the node builds and on what it does with the response, and a fake that
 * records those two things is easier to read than a mock framework's call matchers.
 */

export const NODE: INode = {
	id: 'e6f0a1b2-0000-4000-8000-000000000001',
	name: 'Cosend Trigger',
	type: 'n8n-nodes-cosend.cosendTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

export interface RecordedRequest {
	method: string;
	url: string;
	body?: unknown;
	qs?: IDataObject;
	headers?: Record<string, unknown>;
}

/** axios's error, by the name `NodeApiError` recognises it by: the status and the body, `data`. */
class AxiosError extends Error {
	constructor(
		message: string,
		readonly response: { status: number; data: unknown },
	) {
		super(message);
	}
}

/**
 * The error n8n's `httpRequestWithAuthentication` throws for a refused request.
 *
 * Read from n8n-core 2.16.1's `request-helper-functions.js`: it catches axios's `AxiosError` and
 * throws `new NodeApiError(node, error)`, so the response body is at `cause.response.data`. An
 * earlier version of this fake threw a plain error with `response.body`, which no n8n throws — and
 * the node's error reader passed against it while finding nothing in a real n8n.
 */
export function httpError(status: number, code = 'not_found', message = 'No such thing.') {
	const axiosError = new AxiosError(`Request failed with status code ${status}`, {
		status,
		// A2 §3.4's envelope, so the transport's error reader has something real to read.
		data: { error: { type: 'invalid_request', code, message, request_id: 'req_test', docs: '' } },
	});
	return new NodeApiError(NODE, axiosError as unknown as JsonObject);
}

/**
 * The same refusal as n8n-workflow 2.16.x throws it. Its `NodeApiError` sets no `cause`, so the
 * body is only in `context.data`, where the constructor copies `response.data` in every version.
 */
export function httpErrorWithoutCause(status: number, code?: string, message?: string) {
	const error = httpError(status, code, message);
	error.cause = undefined;
	return error;
}

export interface FakeContextOptions {
	parameters?: Record<string, unknown>;
	staticData?: IDataObject;
	webhookUrl?: string;
	/** Answers one request. Throw from here to simulate an API failure. */
	respond?: (request: RecordedRequest) => unknown;
	rawBody?: string;
	headers?: Record<string, string | string[]>;
	body?: unknown;
}

export interface LoggedLine {
	level: string;
	message: string;
	meta?: IDataObject;
}

/** n8n's `this.logger`, recording what the node logs so a test can read the decision it took. */
function recordingLogger(logs: LoggedLine[]) {
	const at =
		(level: string) =>
		(message: string, meta?: IDataObject): void => {
			logs.push({ level, message, ...(meta === undefined ? {} : { meta }) });
		};
	return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export function createContext(options: FakeContextOptions = {}) {
	const requests: RecordedRequest[] = [];
	const logs: LoggedLine[] = [];
	const staticData: IDataObject = options.staticData ?? {};
	const responseCalls: { status?: number; body?: unknown } = {};

	const context = {
		requests,
		logs,
		staticData,
		responseCalls,

		logger: recordingLogger(logs),
		getNode: () => NODE,
		getCredentials: async () => ({ apiKey: 'cok_live_test', baseUrl: 'https://api.cosend.app/v1' }),
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => options.webhookUrl,

		getNodeParameter(name: string, fallback?: unknown) {
			const value = options.parameters?.[name];
			return value === undefined ? fallback : value;
		},

		getBodyData: () => options.body as IDataObject,

		getRequestObject: () => ({
			// n8n-workflow augments http.IncomingMessage with these two.
			rawBody: options.rawBody === undefined ? undefined : Buffer.from(options.rawBody, 'utf8'),
			readRawBody: async () => {},
			headers: options.headers ?? {},
		}),

		getResponseObject: () => ({
			status(code: number) {
				responseCalls.status = code;
				return this;
			},
			json(body: unknown) {
				responseCalls.body = body;
				return this;
			},
		}),

		helpers: {
			returnJsonArray: (items: unknown) =>
				(Array.isArray(items) ? items : [items]).map((json) => ({ json })),

			httpRequestWithAuthentication: async (
				_credentialType: string,
				requestOptions: IHttpRequestOptions,
			) => {
				const recorded: RecordedRequest = {
					method: String(requestOptions.method),
					url: String(requestOptions.url),
					body: requestOptions.body,
					qs: requestOptions.qs as IDataObject,
					headers: requestOptions.headers as Record<string, unknown>,
				};
				requests.push(recorded);
				return options.respond?.(recorded) ?? {};
			},
		},
	};

	// `cosendApiRequest` invokes the helper with `.call(this, …)`, so it has to be callable that way.
	context.helpers.httpRequestWithAuthentication =
		context.helpers.httpRequestWithAuthentication.bind(context);

	return context;
}

export type FakeContext = ReturnType<typeof createContext>;

export interface FakeExecuteOptions {
	/** One parameter set per input item. */
	items: Record<string, unknown>[];
	continueOnFail?: boolean;
	itemIndex?: number;
	respond?: (request: RecordedRequest) => unknown;
}

/**
 * The execute-side contexts: `IExecuteFunctions` for a custom operation, and
 * `IExecuteSingleFunctions` for a routing `postReceive`. Their `getNodeParameter` takes the item
 * index second, unlike the hook context above.
 */
export function createExecuteContext(options: FakeExecuteOptions) {
	const base = createContext({ respond: options.respond });

	return {
		...base,
		getInputData: () => options.items.map(() => ({ json: {} })),
		getItemIndex: () => options.itemIndex ?? 0,
		continueOnFail: () => options.continueOnFail === true,
		getNodeParameter(name: string, itemIndex: number, fallback?: unknown) {
			const value = options.items[itemIndex]?.[name];
			return value === undefined ? fallback : value;
		},
	};
}
