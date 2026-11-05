import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { cosendApiRequest } from '../shared/transport';

/** Types whose payload is a media object: `{ link | id, caption?, filename? }`. */
const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];

/** Read a resourceLocator and return the value the API should receive. */
export function locatorValue(context: IExecuteFunctions, name: string, itemIndex: number): string {
	const raw = context.getNodeParameter(name, itemIndex, '') as
		string | { value?: unknown } | undefined;
	if (typeof raw === 'string') return raw;
	const value = raw?.value;
	return typeof value === 'string' ? value : '';
}

/** Parse a `json`-typed parameter, naming the parameter when it is not valid JSON. */
export function parseJson(
	context: IExecuteFunctions,
	name: string,
	raw: unknown,
	itemIndex: number,
): unknown {
	if (typeof raw !== 'string') return raw;
	if (raw.trim() === '') return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		throw new NodeOperationError(context.getNode(), `'${name}' is not valid JSON`, {
			itemIndex,
			description: 'Check the field for a missing quote, comma or bracket.',
		});
	}
}

/**
 * Which connection sends this message.
 *
 * `POST /v1/media` requires `connection_id` — it is a plain required string on
 * `uploadMediaRequest`, unlike `sendMessageRequest` where it is optional because a connection key
 * already names one. So a binary attachment needs a connection even when the send itself would
 * not, and the honest resolution order is: what the user chose, then what the conversation says,
 * then an error that names the parameter.
 */
async function resolveConnectionId(context: IExecuteFunctions, itemIndex: number): Promise<string> {
	const chosen = locatorValue(context, 'connectionId', itemIndex);
	if (chosen !== '') return chosen;

	const sendTo = context.getNodeParameter('sendTo', itemIndex, 'contact') as string;
	if (sendTo === 'conversation') {
		const conversationId = locatorValue(context, 'conversationId', itemIndex);
		const conversation = (await cosendApiRequest.call(
			context,
			'GET',
			`/conversations/${conversationId}`,
		)) as unknown as { connection_id?: string };
		if (typeof conversation.connection_id === 'string') return conversation.connection_id;
	}

	throw new NodeOperationError(context.getNode(), "Sending a binary file needs a 'Connection'", {
		itemIndex,
		description:
			"Cosend has to upload the file to one of your WhatsApp numbers before it can send it. Pick one in 'Connection', or use 'Media Source' → 'URL' instead.",
	});
}

/** Upload the item's binary field to Cosend and return the media ID to send it by. */
async function uploadBinary(context: IExecuteFunctions, itemIndex: number): Promise<string> {
	const property = context.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string;
	const metadata = context.helpers.assertBinaryData(itemIndex, property);
	const buffer = await context.helpers.getBinaryDataBuffer(itemIndex, property);

	const body: IDataObject = {
		connection_id: await resolveConnectionId(context, itemIndex),
		mime_type: metadata.mimeType,
		// A2 §5.8 describes a multipart upload; the API takes JSON with base64 (finding
		// MESSAGING-28) and names the field so a later swap to multipart is additive.
		data_base64: buffer.toString('base64'),
	};
	if (metadata.fileName !== undefined) body.filename = metadata.fileName;

	const media = (await cosendApiRequest.call(context, 'POST', '/media', body)) as unknown as {
		id: string;
	};
	return media.id;
}

/** The type-specific object, in WhatsApp's own shape — the API passes it to Meta unchanged. */
async function contentFor(
	context: IExecuteFunctions,
	type: string,
	itemIndex: number,
): Promise<IDataObject> {
	if (type === 'text') {
		return {
			body: context.getNodeParameter('text', itemIndex) as string,
			preview_url: context.getNodeParameter('previewUrl', itemIndex, false) as boolean,
		};
	}

	if (MEDIA_TYPES.includes(type)) {
		const source = context.getNodeParameter('mediaSource', itemIndex, 'url') as string;
		const media: IDataObject =
			source === 'binary'
				? { id: await uploadBinary(context, itemIndex) }
				: source === 'id'
					? { id: context.getNodeParameter('mediaId', itemIndex) as string }
					: { link: context.getNodeParameter('mediaUrl', itemIndex) as string };

		// Meta accepts `caption` on image, video and document only, and `filename` on document
		// only. Sending either on an audio or sticker message is a Meta-side rejection.
		if (['image', 'video', 'document'].includes(type)) {
			const caption = context.getNodeParameter('caption', itemIndex, '') as string;
			if (caption !== '') media.caption = caption;
		}
		if (type === 'document') {
			const filename = context.getNodeParameter('filename', itemIndex, '') as string;
			if (filename !== '') media.filename = filename;
		}
		return media;
	}

	if (type === 'template') {
		const components = parseJson(
			context,
			'Components',
			context.getNodeParameter('templateComponents', itemIndex, '[]'),
			itemIndex,
		);
		const template: IDataObject = {
			name: locatorValue(context, 'templateName', itemIndex),
			language: { code: context.getNodeParameter('templateLanguage', itemIndex) as string },
		};
		if (Array.isArray(components) && components.length > 0) template.components = components;
		return template;
	}

	// location, contacts and interactive are passed through as the user supplied them, because
	// WhatsApp owns those shapes and re-modelling them in the UI would mean re-modelling them
	// again on every change Meta makes.
	const parameter =
		type === 'location' ? 'location' : type === 'contacts' ? 'contacts' : 'interactive';
	const value = parseJson(
		context,
		parameter === 'location' ? 'Location' : parameter === 'contacts' ? 'Contacts' : 'Interactive',
		context.getNodeParameter(parameter, itemIndex, '{}'),
		itemIndex,
	);
	return value as IDataObject;
}

/**
 * Build one `POST /v1/messages` body from the node parameters at `itemIndex`.
 *
 * `sendMessageRequest` is `.strict()`, so every key here has to be one the schema declares —
 * an invented field is a 400, not an ignored extra.
 */
export async function buildMessageBody(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject> {
	const type = context.getNodeParameter('messageType', itemIndex, 'text') as string;
	const sendTo = context.getNodeParameter('sendTo', itemIndex, 'contact') as string;
	const options = context.getNodeParameter('options', itemIndex, {}) as IDataObject;

	const body: IDataObject = { type };

	if (sendTo === 'conversation') {
		body.conversation_id = locatorValue(context, 'conversationId', itemIndex);
	} else {
		body.to = locatorValue(context, 'contactId', itemIndex);
		const connectionId = locatorValue(context, 'connectionId', itemIndex);
		if (connectionId !== '') body.connection_id = connectionId;
	}

	// `contentFor` may upload a file, so it runs before the cheap fields rather than inside the
	// object literal — a throw halfway through building a body is harder to read than a throw here.
	body[type] = await contentFor(context, type, itemIndex);

	if (typeof options.replyTo === 'string' && options.replyTo !== '')
		body.reply_to = options.replyTo;
	if (typeof options.source === 'string') body.source = options.source;

	const sendMode = typeof options.sendMode === 'string' ? options.sendMode : 'strict';
	body.send_mode = sendMode;
	if (sendMode === 'auto') {
		const name =
			typeof options.fallbackTemplateName === 'string' ? options.fallbackTemplateName : '';
		if (name === '') {
			throw new NodeOperationError(
				context.getNode(),
				"'Send Mode' is 'Auto' but no 'Fallback Template Name' is set",
				{
					itemIndex,
					description:
						"Auto sends an approved template when the 24-hour window has closed, so it needs to know which one. Set 'Fallback Template Name', or switch 'Send Mode' to 'Strict'.",
				},
			);
		}
		body.fallback_template = {
			name,
			language:
				typeof options.fallbackTemplateLanguage === 'string' &&
				options.fallbackTemplateLanguage !== ''
					? options.fallbackTemplateLanguage
					: 'en_US',
		};
	}

	const metadata = parseJson(context, 'Metadata', options.metadata, itemIndex);
	if (metadata !== undefined && Object.keys(metadata as IDataObject).length > 0) {
		// A2 §3.5's one open object, `Record<string, string>` — the inbox renders a nested object
		// as `[object Object]`, so the values are stringified here rather than at the far end.
		body.metadata = Object.fromEntries(
			Object.entries(metadata as IDataObject).map(([key, value]) => [
				key,
				typeof value === 'string' ? value : JSON.stringify(value),
			]),
		);
	}

	return body;
}

/** The `Idempotency-Key` for this item, or a generated one. A2 §3.3 makes it required on sends. */
export function idempotencyKeyFor(
	context: IExecuteFunctions,
	itemIndex: number,
	fallback: string,
): string {
	const options = context.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const supplied = typeof options.idempotencyKey === 'string' ? options.idempotencyKey.trim() : '';
	return supplied === '' ? fallback : supplied;
}
