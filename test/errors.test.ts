import type {
	IExecuteFunctions,
	IExecuteSingleFunctions,
	IHookFunctions,
	IN8nHttpFullResponse,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { sendMessage } from '../nodes/Cosend/operations/sendMessage';
import { unwrapData } from '../nodes/Cosend/shared/descriptions';
import { cosendApiRequest, surfaceCosendError } from '../nodes/Cosend/shared/transport';
import { CosendTrigger } from '../nodes/CosendTrigger/CosendTrigger.node';
import {
	createContext,
	createExecuteContext,
	httpError,
	httpErrorWithoutCause,
	NODE,
} from './fakes';

/**
 * cosend.app/docs/n8n: "The node surfaces the API's error envelope rather than flattening it, so
 * the `code` in a failed node's output is the one in the error reference and the `request_id` is
 * the one to quote to support." And /docs/n8n/trigger: "A failed registration surfaces as a node
 * error carrying the API's `code` and `request_id` rather than a generic message."
 */

const REFUSAL = {
	error: {
		type: 'invalid_request',
		code: 'service_window_closed',
		message: 'The 24-hour window is closed.',
		request_id: 'req_01K3F8XK3M9PQRSTVWXYZ01ABC',
		docs: 'https://cosend.app/docs/errors#service_window_closed',
	},
};

const response = (statusCode: number, body: unknown) =>
	({ statusCode, body, headers: {} }) as IN8nHttpFullResponse;

const asSingle = (context: unknown) => context as IExecuteSingleFunctions;

describe('a declarative operation Cosend refused', () => {
	it('passes a success through untouched', async () => {
		const context = createExecuteContext({ items: [{}] });
		const items = [{ json: { id: 'ct_1' } }];

		expect(await surfaceCosendError.call(asSingle(context), items, response(200, {}))).toBe(items);
	});

	/**
	 * Catches: a refusal coming out as data.
	 *
	 * The node sets `ignoreHttpStatusErrors`, so without this check a 409 body would flow on as an
	 * item, and the next node would read `{ error: {…} }` as if it were the contact it asked for.
	 */
	it('throws the API’s own message, with the code and request id in the error’s context', async () => {
		const context = createExecuteContext({ items: [{}], itemIndex: 2 });

		const failure = (await surfaceCosendError
			.call(asSingle(context), [{ json: REFUSAL }], response(409, REFUSAL))
			.catch((error: unknown) => error)) as NodeApiError;

		expect(failure.message).toBe('The 24-hour window is closed.');
		expect(failure.description).toMatch(/approved template/);
		expect(failure.httpCode).toBe('409');
		expect(failure.context).toMatchObject({
			code: 'service_window_closed',
			request_id: 'req_01K3F8XK3M9PQRSTVWXYZ01ABC',
			itemIndex: 2,
		});
		// Logged with the ids, so the failure can be found from the log alone (rule 12).
		expect(context.logs[0]).toMatchObject({
			level: 'warn',
			meta: { status: 409, code: 'service_window_closed' },
		});
	});

	it('hands back one error item carrying the code and request id under Continue On Fail', async () => {
		const context = createExecuteContext({ items: [{}], continueOnFail: true });

		const items = await surfaceCosendError.call(
			asSingle(context),
			[{ json: REFUSAL }],
			response(409, REFUSAL),
		);

		expect(items).toEqual([
			{
				json: {
					error: 'The 24-hour window is closed.',
					code: 'service_window_closed',
					request_id: 'req_01K3F8XK3M9PQRSTVWXYZ01ABC',
					hint: expect.stringMatching(/approved template/),
				},
			},
		]);
	});

	/**
	 * Catches: a list operation losing the failure item.
	 *
	 * n8n runs every `postReceive` in turn, so the item made above reaches the list's unwrap next.
	 * n8n's own `rootProperty: data` turned it into one item with no JSON — the `code` and
	 * `request_id` gone, and the next node handed an empty item.
	 */
	it('keeps the failure item through a list operation’s unwrap', async () => {
		const context = createExecuteContext({ items: [{}], continueOnFail: true });
		const refused = response(403, REFUSAL);
		const [unwrap] = unwrapData.output.postReceive;

		const surfaced = await surfaceCosendError.call(asSingle(context), [{ json: REFUSAL }], refused);
		const listed = await unwrap.call(asSingle(context), surfaced, refused);

		expect(listed).toEqual(surfaced);
		expect(listed[0]?.json).toMatchObject({ code: 'service_window_closed' });
	});

	it('still unwraps a list that succeeded into one item per record', async () => {
		const context = createExecuteContext({ items: [{}] });
		const page = { data: [{ id: 'ct_1' }, { id: 'ct_2' }], has_more: false, next_cursor: null };
		const [unwrap] = unwrapData.output.postReceive;

		expect(await unwrap.call(asSingle(context), [{ json: page }], response(200, page))).toEqual([
			{ json: { id: 'ct_1' } },
			{ json: { id: 'ct_2' } },
		]);
	});

	// Catches: an error with no envelope (a proxy's 502 page) crashing the check itself.
	it('still fails clearly when the body is not Cosend’s envelope', async () => {
		const context = createExecuteContext({ items: [{}] });

		await expect(
			surfaceCosendError.call(asSingle(context), [], response(502, '<html>Bad gateway</html>')),
		).rejects.toThrow('Cosend refused the request (HTTP 502)');
	});
});

describe('a custom operation Cosend refused', () => {
	/**
	 * Catches: the API's words lost to n8n's generic one.
	 *
	 * n8n's helper throws a `NodeApiError` already (see `httpError` in fakes.ts), and that
	 * constructor hands an existing `NodeApiError` back unchanged — so wrapping it again keeps n8n's
	 * "Your request is invalid…" and drops the message, code and request id passed alongside.
	 */
	it('wraps the HTTP error with the API’s message, code and request id', async () => {
		const context = createExecuteContext({
			items: [{}],
			respond: () => {
				throw httpError(409, 'service_window_closed', 'The 24-hour window is closed.');
			},
		});

		const failure = (await cosendApiRequest
			.call(context as unknown as IExecuteFunctions, 'POST', '/messages', {})
			.catch((error: unknown) => error)) as NodeApiError;

		expect(failure.message).toBe('The 24-hour window is closed.');
		expect(failure.description).toMatch(/approved template/);
		expect(failure.httpCode).toBe('409');
		expect(failure.context).toMatchObject({
			code: 'service_window_closed',
			request_id: 'req_test',
		});
	});

	/**
	 * Catches: the API's words lost on an older n8n.
	 *
	 * On n8n-workflow 2.16.x the `NodeApiError` has no `cause`, so the body is only in its
	 * `context.data`, and the constructor hands that same error back with n8n's generic message.
	 */
	it('reads the envelope from the error’s context when it has no cause, as n8n-workflow 2.16 throws it', async () => {
		const thrown = httpErrorWithoutCause(
			409,
			'service_window_closed',
			'The 24-hour window is closed.',
		);
		expect(thrown.cause).toBeUndefined();
		expect(thrown.context.data).toMatchObject({ error: { code: 'service_window_closed' } });
		const context = createExecuteContext({
			items: [{}],
			respond: () => {
				throw thrown;
			},
		});

		const failure = (await cosendApiRequest
			.call(context as unknown as IExecuteFunctions, 'POST', '/messages', {})
			.catch((error: unknown) => error)) as NodeApiError;

		expect(failure.message).toBe('The 24-hour window is closed.');
		expect(failure.description).toMatch(/approved template/);
		expect(failure.httpCode).toBe('409');
		expect(failure.context).toMatchObject({
			code: 'service_window_closed',
			request_id: 'req_test',
		});
	});

	it('does not repeat the API’s message as the description on that older error', async () => {
		const context = createExecuteContext({
			items: [{}],
			respond: () => {
				throw httpErrorWithoutCause(404, 'not_found', 'No such contact.');
			},
		});

		const failure = (await cosendApiRequest
			.call(context as unknown as IExecuteFunctions, 'GET', '/contacts/ct_x')
			.catch((error: unknown) => error)) as NodeApiError;

		expect(failure.message).toBe('No such contact.');
		expect(failure.description).not.toBe('No such contact.');
	});

	// Catches: n8n's diagnosis of a refused connection replaced by a generic fallback.
	it('keeps n8n’s own message when the older error carries no Cosend envelope', async () => {
		const thrown = new NodeApiError(NODE, {
			message: 'connect ECONNREFUSED 10.0.0.1:443',
			code: 'ECONNREFUSED',
		});
		thrown.cause = undefined;
		const n8nMessage = thrown.message;
		const context = createExecuteContext({
			items: [{}],
			respond: () => {
				throw thrown;
			},
		});

		const failure = (await cosendApiRequest
			.call(context as unknown as IExecuteFunctions, 'GET', '/me')
			.catch((error: unknown) => error)) as NodeApiError;

		expect(n8nMessage).not.toMatch(/Cosend API request failed/);
		expect(failure.message).toBe(n8nMessage);
	});

	/**
	 * **Catches the regression this ticket found:** Send's error output had no `code`. It read
	 * `error.response.body`, but n8n throws a `NodeApiError` whose `cause` is axios's error, with
	 * the body at `response.data` — so the code it promised was never there.
	 */
	it('puts the code and request id on Send’s error output', async () => {
		const context = createExecuteContext({
			items: [
				{
					messageType: 'text',
					sendTo: 'contact',
					contactId: { value: '+919876543210' },
					text: 'Hello',
					options: {},
				},
			],
			continueOnFail: true,
			respond: () => {
				throw httpError(409, 'service_window_closed', 'The 24-hour window is closed.');
			},
		});

		const [output] = await sendMessage.call(context as unknown as IExecuteFunctions);

		expect(output?.[0]?.json).toMatchObject({
			error: 'The 24-hour window is closed.',
			code: 'service_window_closed',
			request_id: 'req_test',
			hint: expect.stringMatching(/approved template/),
		});
	});

	it('names the API’s code and request id when the trigger cannot register', async () => {
		const context = createContext({
			webhookUrl: 'https://n8n.example.com/webhook/abc/webhook',
			parameters: { events: ['message.received'], connectionId: '' },
			respond: () => {
				throw httpError(403, 'insufficient_scope', 'This key cannot manage webhooks.');
			},
		});

		const failure = (await new CosendTrigger().webhookMethods.default.create
			.call(context as unknown as IHookFunctions)
			.catch((error: unknown) => error)) as NodeApiError;

		expect(failure.message).toBe('This key cannot manage webhooks.');
		expect(failure.description).toMatch(/scope/);
		expect(failure.context).toMatchObject({ code: 'insufficient_scope', request_id: 'req_test' });
	});
});
