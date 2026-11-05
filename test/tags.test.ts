import type {
	INodeProperties,
	INodePropertyOptions,
	IWorkflowDataProxyData,
} from 'n8n-workflow';
import { Expression } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { contactDescription } from '../nodes/Cosend/resources/contact';

interface Routing {
	request?: { method?: string; url?: string };
	send?: { type?: string; property?: string; value?: string };
}

const expression = new Expression('UTC');
const resolve = (value: string, data: Record<string, unknown>): unknown =>
	expression.resolveSimpleParameterValue(value, data as unknown as IWorkflowDataProxyData);

const operations = contactDescription.find((property) => property.name === 'operation')
	?.options as INodePropertyOptions[];
const tags = contactDescription.find((property) => property.name === 'tags') as INodeProperties & {
	routing?: Routing;
};

/** The request one tag operation makes, its URL and body built by n8n's own expression engine. */
function requestOf(operation: string, contactId: string, tagsText: string) {
	const option = operations.find((entry) => entry.value === operation) as INodePropertyOptions & {
		routing?: Routing;
	};
	const send = tags.routing?.send;
	return {
		method: option.routing?.request?.method,
		url: resolve(option.routing?.request?.url ?? '', { $parameter: { contactId } }),
		body: { [send?.property ?? '']: resolve(send?.value ?? '', { $value: tagsText }) },
	};
}

/**
 * Catches: Add Tags and Remove Tags written as Update.
 *
 * `PATCH /v1/contacts/{id}` replaces the whole tag list, so two workflows tagging one contact lose
 * each other's tags. The tag routes add or take off only the tags named.
 */
describe('Contact: Add Tags and Remove Tags', () => {
	it('adds through POST /contacts/{id}/tags with the tags as a list', () => {
		expect(requestOf('addTags', 'ct_01H8XK3M9PQRSTUVWXYZ01AB', ' vip, india ,,')).toEqual({
			method: 'POST',
			url: '/contacts/ct_01H8XK3M9PQRSTUVWXYZ01AB/tags',
			body: { tags: ['vip', 'india'] },
		});
	});

	it('removes through DELETE /contacts/{id}/tags with the tags as a list', () => {
		expect(requestOf('removeTags', '+919876543210', 'vip')).toEqual({
			method: 'DELETE',
			url: '/contacts/+919876543210/tags',
			body: { tags: ['vip'] },
		});
	});

	it('shows the contact and the tags for both, and the tags for nothing else', () => {
		const shownFor = (name: string) =>
			contactDescription.find((property) => property.name === name)?.displayOptions?.show
				?.operation;
		expect(shownFor('contactId')).toEqual(expect.arrayContaining(['addTags', 'removeTags']));
		expect(shownFor('tags')).toEqual(['addTags', 'removeTags']);
	});
});
