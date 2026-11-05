import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { cosendApiRequest, cosendApiRequestAllItems } from '../Cosend/shared/transport';
import { verifyCosendSignature } from './signature';
import { type CosendEventEnvelope, simplifyEvent } from './simplify';

interface CosendWebhookStaticData {
	webhookId?: string;
	webhookSecret?: string;
	/** An endpoint that no longer matches the workflow, removed once its replacement exists. */
	staleWebhookId?: string;
}

/**
 * A webhook endpoint's `filters`. Cosend applies them before it delivers: an event a filter leaves
 * out is never sent, so it starts no execution. Members combine as AND, one member's values as OR,
 * and each member applies only to its own events, letting every other event through.
 */
type EndpointFilters = Record<string, string[]>;

interface EndpointRecord {
	id: string;
	url: string;
	events: string[];
	connection_id: string | null;
	filters?: EndpointFilters;
	include_contact?: boolean;
	secret?: string;
}

/** A filter's values: a multi-select's list, or comma-separated text. Blanks and repeats dropped. */
function valuesOf(value: unknown): string[] {
	const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	const texts = values
		.filter((entry): entry is string => typeof entry === 'string')
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
	return [...new Set(texts)];
}

const sameValues = (held: string[], wanted: string[]) =>
	held.length === wanted.length && wanted.every((value) => held.includes(value));

/** Whether an endpoint's filters are the ones wanted. A member absent on either side is none. */
function sameFilters(held: EndpointFilters | undefined, wanted: EndpointFilters): boolean {
	const members = new Set([...Object.keys(held ?? {}), ...Object.keys(wanted)]);
	return [...members].every((member) => sameValues(held?.[member] ?? [], wanted[member] ?? []));
}

/**
 * The id of the API key this credential holds, which is what Cosend records on every message sent
 * with it. `GET /v1/me` answers it for any valid key, whatever its scopes.
 */
async function credentialKeyId(this: IHookFunctions): Promise<string> {
	const me: unknown = await cosendApiRequest.call(this, 'GET', '/me');
	const credential: unknown =
		typeof me === 'object' && me !== null ? Reflect.get(me, 'credential') : undefined;
	const id: unknown =
		typeof credential === 'object' && credential !== null
			? Reflect.get(credential, 'id')
			: undefined;
	if (typeof id !== 'string' || id === '') {
		throw new NodeOperationError(
			this.getNode(),
			'Could not tell which Cosend API key this credential holds',
			{
				description:
					"Turn off 'Ignore Messages Sent by Me', or check the Cosend credential is an API key.",
			},
		);
	}
	return id;
}

/** The filters the node's parameters ask Cosend for, as `POST /v1/webhook-endpoints` takes them. */
async function wantedFilters(this: IHookFunctions): Promise<EndpointFilters> {
	const chosen = this.getNodeParameter('filters', {}) as IDataObject;
	const wanted: EndpointFilters = {};
	const set = (member: string, values: string[]) => {
		if (values.length > 0) wanted[member] = values;
	};
	set('message_types', valuesOf(chosen.messageTypes));
	set('message_statuses', valuesOf(chosen.statuses));
	set('labels', valuesOf(chosen.labels));
	set('assignee_ids', valuesOf(chosen.assigneeIds));
	set('automation_ids', valuesOf(chosen.automationIds));
	if (this.getNodeParameter('ignoreSentByMe', true) === true) {
		set('exclude_sent_by_api_key_ids', [await credentialKeyId.call(this)]);
	}
	return wanted;
}

/** Include Contact is on unless switched off, as Simplify is. */
function wantsContact(this: IHookFunctions): boolean {
	const options = this.getNodeParameter('options', {}) as IDataObject;
	return options.includeContact !== false;
}

/**
 * The events offered here are exactly the ones something in cosend-api emits.
 *
 * A2 §7.2's catalogue is closed, and `POST /v1/webhook-endpoints` accepts a subscription to any
 * name in it. Offering one that nothing produces would put an entry in the dropdown that starts a
 * workflow which can never run — standing rule 9's first half. `test/contract.test.ts` holds this
 * list equal to the catalogue's produced events in the generated fixture, so a new producer fails
 * the build until it is offered here, and a renamed event fails it at once.
 *
 * Every event cosend.app/n8n names is here: the seven message and conversation events,
 * `contact.consent_changed`, `automation.run_finished` with `.run_failed`,
 * `connection.disconnected` with `.needs_reauth`, and `usage.threshold_reached`.
 *
 * `ping` is excluded for a different reason: it is emitted only by
 * `POST /v1/webhook-endpoints/{id}/test`, and `webhook()` answers it without starting a workflow.
 */
const EVENT_OPTIONS = [
	{
		name: 'Approval Decided',
		value: 'approval.decided',
		description: 'Someone approved or declined a step an automation was waiting on',
	},
	{
		name: 'Approval Requested',
		value: 'approval.requested',
		description: 'An automation is waiting for someone to approve a step',
	},
	{
		name: 'Automation Run Failed',
		value: 'automation.run_failed',
		description: 'An automation run stopped because a step failed',
	},
	{
		name: 'Automation Run Finished',
		value: 'automation.run_finished',
		description: 'An automation run reached its end',
	},
	{
		name: 'Automation Run Started',
		value: 'automation.run_started',
		description: 'An automation run began',
	},
	{
		name: 'Automation Switched Off',
		value: 'automation.auto_disabled',
		description: 'Cosend switched an automation off by itself. The event says why.',
	},
	{
		name: 'Connection Connected',
		value: 'connection.connected',
		description: 'A WhatsApp number finished connecting to Cosend',
	},
	{
		name: 'Connection Disconnected',
		value: 'connection.disconnected',
		description: 'A WhatsApp connection stopped working',
	},
	{
		name: 'Connection Messaging Limit Changed',
		value: 'connection.limit_changed',
		description: 'Meta changed how many people a WhatsApp number may start conversations with',
	},
	{
		name: 'Connection Needs Reauthorization',
		value: 'connection.needs_reauth',
		description: 'A WhatsApp connection needs the owner to sign in again',
	},
	{
		name: 'Connection Quality Changed',
		value: 'connection.quality_changed',
		description: 'Meta changed the quality rating of a WhatsApp number',
	},
	{
		name: 'Contact Consent Changed',
		value: 'contact.consent_changed',
		description: 'A contact opted in or opted out',
	},
	{ name: 'Contact Created', value: 'contact.created', description: 'A new contact was added' },
	{
		name: 'Contact Updated',
		value: 'contact.updated',
		description: 'A contact’s details changed',
	},
	{
		name: 'Conversation Created',
		value: 'conversation.created',
		description: 'A new conversation thread opened',
	},
	{
		name: 'Conversation Lock Changed',
		value: 'conversation.lock_changed',
		description: 'A team member took or released a conversation',
	},
	{
		name: 'Conversation Lock Request Resolved',
		value: 'conversation.lock_request_resolved',
		description:
			'A request for control of a conversation ended: granted, declined, or granted because nobody answered',
	},
	{
		name: 'Conversation Lock Requested',
		value: 'conversation.lock_requested',
		description: 'A team member asked another for control of a conversation',
	},
	{
		name: 'Conversation Updated',
		value: 'conversation.updated',
		description: 'A conversation’s state, assignee, control or labels changed',
	},
	{
		name: 'Conversation Window Expiring',
		value: 'conversation.window_expiring',
		description:
			'The 24-hour window closes in one hour. After it shuts, only an approved template can be sent.',
	},
	{
		name: 'Message Echo',
		value: 'message.echo',
		description:
			'The owner replied from the WhatsApp Business app on their phone. Only a coexistence number can emit this.',
	},
	{
		name: 'Message Received',
		value: 'message.received',
		description: 'A contact sent you a WhatsApp message',
	},
	{ name: 'Message Sent', value: 'message.sent', description: 'Cosend accepted a message to send' },
	{
		name: 'Message Status Changed',
		value: 'message.status',
		description: 'An outgoing message was sent, delivered, read or failed',
	},
	{
		name: 'Note Created',
		value: 'note.created',
		description:
			'A team member wrote an internal note on a conversation. The event carries the note’s IDs, not its text.',
	},
	{
		name: 'Note Deleted',
		value: 'note.deleted',
		description: 'An internal note was deleted',
	},
	{
		name: 'Note Updated',
		value: 'note.updated',
		description: 'An internal note’s text was edited',
	},
	{
		name: 'Notification Delivered',
		value: 'notification.delivered',
		description: 'A queued notification reached the recipient’s phone',
	},
	{
		name: 'Notification Expired',
		value: 'notification.expired',
		description: 'A queued notification passed its expiry and was dropped rather than sent late',
	},
	{
		name: 'Notification Failed',
		value: 'notification.failed',
		description: 'A queued notification could not be delivered',
	},
	{
		name: 'Notification Sent',
		value: 'notification.sent',
		description: 'A queued notification went out',
	},
	{
		name: 'Onboarding Completed',
		value: 'onboarding.completed',
		description: 'A customer finished connecting their WhatsApp number',
	},
	{
		name: 'Onboarding Failed',
		value: 'onboarding.failed',
		description: 'A customer’s WhatsApp connection attempt failed',
	},
	{
		name: 'Onboarding Progress',
		value: 'onboarding.progress',
		description: 'A customer moved a step through connecting their WhatsApp number',
	},
	{
		name: 'Template Status Changed',
		value: 'template.status_changed',
		description: 'Meta approved, rejected or paused one of your templates',
	},
	{
		name: 'Usage Threshold Reached',
		value: 'usage.threshold_reached',
		description: 'A meter reached 80% or 100% of what your plan includes',
	},
];

/** The names this node offers, for the drift test to check against the generated catalogue. */
export const OFFERED_EVENTS = EVENT_OPTIONS.map((option) => option.value);

export class CosendTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cosend Trigger',
		name: 'cosendTrigger',
		icon: { light: 'file:../../icons/cosend.svg', dark: 'file:../../icons/cosend.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts a workflow when something happens in Cosend',
		defaults: { name: 'Cosend Trigger' },
		// `trigger-node-conventions`: a class ending in `Trigger` must have `inputs: []`, and
		// `node-usable-as-tool` forbids `usableAsTool: true` on a trigger.
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'cosendApi', required: true }],
		webhooks: [
			{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' },
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['message.received'],
				description:
					'The Cosend events that start this workflow. Cosend only delivers the events you pick here.',
				options: EVENT_OPTIONS,
			},
			{
				displayName: 'Connection Name or ID',
				name: 'connectionId',
				type: 'string',
				default: '',
				placeholder: 'e.g. conn_01H8XK3M9PQRSTUVWXYZ01',
				description:
					'Only receive events for this WhatsApp connection. Leave empty for every connection in the workspace. Cosend applies this filter itself.',
			},
			{
				displayName: 'Ignore Messages Sent by Me',
				name: 'ignoreSentByMe',
				type: 'boolean',
				default: true,
				description:
					"Whether to leave out messages sent with this credential's API key, so a workflow that sends a message does not start itself again. Applies to 'Message Sent' and 'Message Status Changed': the status changes of those messages are left out too, so turn this off to track their delivery. Cosend applies this filter itself.",
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				description:
					'Narrow down which events reach the workflow. Cosend applies these filters itself and delivers only the events that match. Each filter applies to the events its description names and lets every other event through.',
				options: [
					{
						displayName: 'Assigned Agent IDs',
						name: 'assigneeIds',
						type: 'string',
						default: '',
						placeholder: 'e.g. usr_01H8XK3M9PQRSTUVWXYZ01',
						description:
							'Comma-separated IDs of team members. Only continue when the conversation is assigned to one of them. Applies to message and conversation events.',
					},
					{
						displayName: 'Automation IDs',
						name: 'automationIds',
						type: 'string',
						default: '',
						placeholder: 'e.g. aut_01H8XK3M9PQRSTUVWXYZ01',
						description:
							'Comma-separated automation IDs. Only continue for runs and approvals of one of these automations. Applies to automation and approval events.',
					},
					{
						displayName: 'Labels',
						name: 'labels',
						type: 'string',
						default: '',
						placeholder: 'e.g. vip,urgent',
						description:
							'Comma-separated labels. Only continue when the conversation carries at least one of them. Applies to message and conversation events.',
					},
					{
						displayName: 'Message Types',
						name: 'messageTypes',
						type: 'multiOptions',
						default: [],
						description:
							'Only continue for these kinds of message. Applies to every message event, sent messages and status changes included: pick Template to keep the status changes of template sends.',
						// Every type `filters.message_types` accepts, so no message event is out of reach.
						options: [
							{ name: 'Audio', value: 'audio' },
							{ name: 'Button', value: 'button' },
							{ name: 'Contacts', value: 'contacts' },
							{ name: 'Document', value: 'document' },
							{ name: 'Image', value: 'image' },
							{ name: 'Interactive', value: 'interactive' },
							{ name: 'Location', value: 'location' },
							{ name: 'Order', value: 'order' },
							{ name: 'Reaction', value: 'reaction' },
							{ name: 'Sticker', value: 'sticker' },
							{ name: 'System', value: 'system' },
							{ name: 'Template', value: 'template' },
							{ name: 'Text', value: 'text' },
							{ name: 'Unsupported', value: 'unsupported' },
							{ name: 'Video', value: 'video' },
						],
					},
					{
						displayName: 'Statuses',
						name: 'statuses',
						type: 'multiOptions',
						default: [],
						description:
							"Only continue for these delivery statuses. Applies to 'Message Status Changed'.",
						options: [
							{ name: 'Delivered', value: 'delivered' },
							{ name: 'Failed', value: 'failed' },
							{ name: 'Read', value: 'read' },
							{ name: 'Sent', value: 'sent' },
						],
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Include Contact',
						name: 'includeContact',
						type: 'boolean',
						default: true,
						description:
							'Whether conversation events carry the conversation’s contact. Message events always carry theirs.',
					},
					{
						displayName: 'Simplify',
						name: 'simplify',
						type: 'boolean',
						default: true,
						description:
							'Whether to return the resource itself with the event name attached, instead of Cosend’s full event envelope',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			/**
			 * **There is no `GET /v1/webhook-endpoints/{id}`.** A2 §5.16 gives the collection a
			 * GET, a POST, and the item a PATCH and a DELETE — and no item GET. Doc 03 §4.4 says
			 * to fetch the endpoint by id; that request 404s. Listing and finding is the shape the
			 * contract actually supports, so that is what this does.
			 */
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node') as CosendWebhookStaticData;
				if (staticData.webhookId === undefined) return false;

				const webhookUrl = this.getNodeWebhookUrl('default');
				const events = this.getNodeParameter('events') as string[];
				const connectionId = this.getNodeParameter('connectionId', '') as string;

				let endpoints: EndpointRecord[];
				try {
					endpoints = await cosendApiRequestAllItems.call<
						IHookFunctions,
						[string],
						Promise<EndpointRecord[]>
					>(this, '/webhook-endpoints');
				} catch (error) {
					// `no-silent-error-swallowing`: an auth or network failure is not "the webhook is
					// gone". Swallowing it here re-registers a duplicate endpoint on every activation.
					throw new NodeOperationError(this.getNode(), error as Error, {
						message: 'Could not check the Cosend webhook subscription',
						description:
							'Check the Cosend credential is still valid and carries the webhooks:read scope.',
					});
				}

				const existing = endpoints.find((endpoint) => endpoint.id === staticData.webhookId);
				if (existing !== undefined) {
					const sameUrl = existing.url === webhookUrl;
					const sameEvents = sameValues(existing.events, events);
					const sameConnection =
						(existing.connection_id ?? '') === (connectionId === '' ? '' : connectionId);
					const sameFilterSet = sameFilters(existing.filters, await wantedFilters.call(this));
					const sameContact = (existing.include_contact ?? false) === wantsContact.call(this);
					if (sameUrl && sameEvents && sameConnection && sameFilterSet && sameContact) {
						return true;
					}

					// cosend.app/docs/n8n/trigger: an endpoint whose URL or events no longer match
					// "is replaced rather than left pointing somewhere stale"; so is one whose filters
					// or Include Contact no longer match. It is removed by
					// `create`, AFTER the new one exists: removed here, a refused `create` would leave
					// the workflow with no subscription at all.
					staticData.staleWebhookId = existing.id;
					this.logger.info(
						'Cosend Trigger will replace a webhook endpoint that no longer matches',
						{
							endpointId: existing.id,
							urlChanged: !sameUrl,
							eventsChanged: !sameEvents,
							connectionChanged: !sameConnection,
							filtersChanged: !sameFilterSet,
							includeContactChanged: !sameContact,
						},
					);
				}

				// Gone, or about to be replaced. Forget it so `create` registers a new one — and drop
				// the secret with it, because a new endpoint gets a new one and a stale secret rejects
				// every delivery.
				delete staticData.webhookId;
				delete staticData.webhookSecret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				if (webhookUrl === undefined || /localhost|127\.0\.0\.1|::1/.test(webhookUrl)) {
					// Cosend re-resolves and guards the destination address on every delivery
					// (SI-6/DNS rebinding), so a private URL is refused at delivery time anyway.
					// Failing here names the problem while the user is looking at the node.
					throw new NodeOperationError(
						this.getNode(),
						'Cosend cannot reach this n8n instance because its webhook URL is not public',
						{
							description:
								'Use n8n Cloud, a tunnel, or set WEBHOOK_URL to a public address. Alternatively, point a Cosend outbound webhook at the built-in Webhook node instead of using this trigger.',
						},
					);
				}

				const connectionId = this.getNodeParameter('connectionId', '') as string;

				// `createEndpointRequest` is `.strict()`: `url`, `events`, an optional `connection_id`,
				// `filters` and `include_contact`. Anything else (Doc 03 §5.12's draft also sent
				// `source`) is a 400 on every activation.
				const filters = await wantedFilters.call(this);
				const includeContact = wantsContact.call(this);
				const body: IDataObject = {
					url: webhookUrl,
					events: this.getNodeParameter('events') as string[],
					filters,
					include_contact: includeContact,
				};
				if (connectionId !== '') body.connection_id = connectionId;
				this.logger.info('Cosend Trigger is registering a webhook endpoint', {
					filterMembers: Object.keys(filters).join(','),
					includeContact,
				});

				const created = (await cosendApiRequest.call(
					this,
					'POST',
					'/webhook-endpoints',
					body,
				)) as unknown as EndpointRecord;

				const staticData = this.getWorkflowStaticData('node') as CosendWebhookStaticData;
				const stale = staticData.staleWebhookId;
				if (stale !== undefined) {
					try {
						await cosendApiRequest.call(this, 'DELETE', `/webhook-endpoints/${stale}`);
					} catch (error) {
						// Already gone is what we wanted. Anything else fails the activation, and n8n
						// keeps no static data from a `create` that throws, so the new endpoint's id
						// would be lost: live, and nothing left that can remove it. So it is removed
						// before the error is raised, and Cosend is left as it was, with the old
						// endpoint still there for the next activation to replace.
						if ((error as { httpCode?: string }).httpCode !== '404') {
							const ids = { endpointId: created.id, staleEndpointId: stale };
							let description =
								'It may still be active in Cosend. Remove it under Settings → Webhooks, then activate the workflow again.';
							try {
								await cosendApiRequest.call(this, 'DELETE', `/webhook-endpoints/${created.id}`);
								this.logger.warn(
									'Cosend Trigger could not remove the old webhook endpoint, so it removed the new one and left Cosend as it was',
									ids,
								);
							} catch (removeError) {
								this.logger.error(
									'Cosend Trigger could not remove the old webhook endpoint, nor the new one it had just created',
									{
										...ids,
										reason:
											removeError instanceof Error ? removeError.message : String(removeError),
									},
								);
								description =
									'Cosend now has two subscriptions for this workflow: the old one and the one just created. Remove both under Settings → Webhooks, then activate the workflow again.';
							}
							throw new NodeOperationError(this.getNode(), error as Error, {
								message: 'Could not remove the old Cosend webhook subscription',
								description,
							});
						}
					}
					delete staticData.staleWebhookId;
					this.logger.info('Cosend Trigger replaced a webhook endpoint', {
						removedEndpointId: stale,
						endpointId: created.id,
					});
				}

				staticData.webhookId = created.id;
				// A2 §5.16: the signing secret is "included once". There is no path that can read it
				// back, so losing it here means deleting and re-creating the endpoint.
				staticData.webhookSecret = created.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node') as CosendWebhookStaticData;
				if (staticData.webhookId === undefined) return true;

				try {
					await cosendApiRequest.call(this, 'DELETE', `/webhook-endpoints/${staticData.webhookId}`);
				} catch (error) {
					const httpCode = (error as { httpCode?: string }).httpCode;
					// A 404 means the endpoint is already gone, which is the state we wanted. Anything
					// else is a real failure and must surface — deleting the local id while the remote
					// endpoint survives leaves an orphan delivering into a dead URL forever.
					if (httpCode !== '404') {
						throw new NodeOperationError(this.getNode(), error as Error, {
							message: 'Could not remove the Cosend webhook subscription',
							description:
								'The subscription may still be active in Cosend. Remove it under Settings → Webhooks.',
						});
					}
				}

				delete staticData.webhookId;
				delete staticData.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject();
		const staticData = this.getWorkflowStaticData('node') as CosendWebhookStaticData;

		/**
		 * **THE RAW BYTES, NOT A RE-SERIALISATION.** A2 §7.3 signs `` `${t}.${rawBody}` ``, and
		 * `JSON.stringify(this.getBodyData())` is not that string: parsing and re-printing changes
		 * unicode escaping, number formatting and key order, so the HMAC never matches. This repo
		 * says the same thing about its own inbound verifier — "Re-serialising loses Meta's exact
		 * escaping and the HMAC will never" match — and Doc 03 §5.12's draft does exactly that.
		 *
		 * `rawBody` is declared on `http.IncomingMessage` by `n8n-workflow`'s own module
		 * augmentation, alongside `readRawBody()` for when it has not been captured yet.
		 */
		if (request.rawBody === undefined) await request.readRawBody();
		const rawBody = request.rawBody?.toString('utf8') ?? '';

		const header = request.headers['cosend-signature'];
		const signature = Array.isArray(header) ? header[0] : header;

		if (
			!verifyCosendSignature(
				rawBody,
				signature,
				staticData.webhookSecret,
				Math.floor(Date.now() / 1000),
			)
		) {
			// No workflow data: an unsigned or stale delivery must not start an execution, and 401
			// is what tells Cosend to stop retrying against a node that will never accept it.
			const response = this.getResponseObject();
			response.status(401).json({ error: 'invalid signature' });
			return { noWebhookResponse: true };
		}

		const envelope = this.getBodyData() as CosendEventEnvelope;

		// A2 §7.2: `ping` is emitted only by `POST /v1/webhook-endpoints/{id}/test`. Answering 200
		// is what makes the dashboard's Test button go green; starting a workflow for it would run
		// the customer's automation against an event that describes nothing.
		if (envelope.type === 'ping') return { webhookResponse: { received: true } };

		const options = this.getNodeParameter('options', {}) as IDataObject;
		const payload = options.simplify === false ? envelope : simplifyEvent(envelope);

		return { workflowData: [this.helpers.returnJsonArray([payload])] };
	}
}
