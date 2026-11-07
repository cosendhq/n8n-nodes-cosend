import type { IDataObject } from 'n8n-workflow';

import { recordKindOf, simplifyRecord } from '../Cosend/shared/output';

/** A2 §7.1 — one envelope for every event, every type. */
export interface CosendEventEnvelope extends IDataObject {
	id?: string;
	object?: string;
	type?: string;
	api_version?: string;
	created_at?: string;
	organization_id?: string;
	connection_id?: string | null;
	data?: { object?: unknown };
	previous_attributes?: IDataObject;
}

/**
 * Flatten A2 §7.1's envelope into the resource plus the few facts about the event itself.
 *
 * `data.object` is "the full `/v1` representation of the resource, identical to what `GET`
 * returns", so the simplified item is the same shape a `Cosend → Get` node would emit — which is
 * the whole point: a workflow that reacts to a message and a workflow that fetches one parse the
 * same object.
 *
 * The resource is spread first and the event facts second, so `event`, `event_id` and
 * `event_created_at` always mean what they say even if a resource ever grows a field of the same
 * name. `previous_attributes` is carried through untouched — A2 says it "appears only on
 * `*.updated` events and lists just the changed fields", and it is the only way a workflow can
 * tell *what* changed.
 */
export function simplifyEvent(envelope: CosendEventEnvelope): IDataObject {
	const object = envelope.data?.object;
	const resource: IDataObject =
		typeof object === 'object' && object !== null && !Array.isArray(object)
			? (object as IDataObject)
			: ({ data: object } as IDataObject);

	return {
		...resource,
		event: envelope.type,
		event_id: envelope.id,
		event_created_at: envelope.created_at,
		connection_id: envelope.connection_id ?? null,
		...(envelope.previous_attributes === undefined
			? {}
			: { previous_attributes: envelope.previous_attributes }),
	};
}

/**
 * Simplify from version 1.1, as n8n's UX guidelines ask: at most ten fields, flat, the most used
 * first. `event`, then the record in the same simplified shape the Cosend node's Simplify gives
 * it, so a message reads the same from the trigger and from Message: Get. A record with no
 * simplified shape keeps its ID and its first plain fields, up to ten in all.
 */
export function simplifiedEvent(envelope: CosendEventEnvelope): IDataObject {
	const object = envelope.data?.object;
	const resource: IDataObject =
		typeof object === 'object' && object !== null && !Array.isArray(object)
			? (object as IDataObject)
			: {};
	const kind = recordKindOf(resource);
	if (kind !== undefined) return { event: envelope.type, ...simplifyRecord(kind, resource) };

	const plain = Object.entries(resource).filter(
		([key, value]) => key !== 'id' && key !== 'object' && (value === null || typeof value !== 'object'),
	);
	return {
		event: envelope.type,
		id: resource.id ?? null,
		...Object.fromEntries(plain.slice(0, 8)),
	};
}
