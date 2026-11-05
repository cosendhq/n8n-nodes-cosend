import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { CosendApi } from '../credentials/CosendApi.credentials';
import { Cosend } from '../nodes/Cosend/Cosend.node';
import { CosendTrigger } from '../nodes/CosendTrigger/CosendTrigger.node';
import darkIcon from '../icons/cosend.dark.svg?raw';
import lightIcon from '../icons/cosend.svg?raw';
import packageJson from '../package.json';

const action = new Cosend().description;
const trigger = new CosendTrigger().description;

/** Every property, including the ones nested inside `collection` and `fixedCollection` options. */
function flatten(properties: INodeProperties[]): INodeProperties[] {
	return properties.flatMap((property) => [
		property,
		...flatten((property.options ?? []) as INodeProperties[]),
	]);
}

const operationProperties = (properties: INodeProperties[]) =>
	properties.filter((property) => property.name === 'operation');

const optionValues = (properties: INodeProperties[], name: string): string[] => {
	const property = flatten(properties).find((candidate) => candidate.name === name);
	return ((property?.options ?? []) as INodePropertyOptions[]).map((option) =>
		String(option.value),
	);
};

describe('n8n verification invariants', () => {
	it('declares the fields the community-nodes linter requires on the action node', () => {
		expect(action.icon).toBeDefined();
		expect(action.subtitle).toBeDefined();
		// `node-usable-as-tool`: every non-trigger node must declare it.
		expect(action.usableAsTool).toBe(true);
		expect(action.defaults.name).toBeTruthy();
	});

	it('follows the trigger-node conventions', () => {
		// `trigger-node-conventions`: class ends in Trigger ⇒ name ends in Trigger, displayName
		// contains Trigger, and inputs is empty.
		expect(trigger.name.endsWith('Trigger')).toBe(true);
		expect(trigger.displayName).toContain('Trigger');
		expect(trigger.inputs).toEqual([]);
		// The same rule forbids `usableAsTool: true` on a trigger.
		expect(trigger.usableAsTool).not.toBe(true);
		expect(trigger.icon).toBeDefined();
		expect(trigger.subtitle).toBeDefined();
	});

	it('starts the action node with a Resource selector', () => {
		expect(action.properties[0]?.name).toBe('resource');
		expect(action.properties[0]?.noDataExpression).toBe(true);
	});

	it('marks every operation selector noDataExpression', () => {
		for (const property of operationProperties(action.properties)) {
			expect(property.noDataExpression, `${String(property.displayOptions?.show?.resource)}`).toBe(
				true,
			);
		}
	});

	// n8n's UX guidelines: `action` is what the node renders in the actions panel, and a missing
	// one is a blank row there.
	it('gives every operation an action and a description', () => {
		for (const property of operationProperties(action.properties)) {
			for (const option of (property.options ?? []) as INodePropertyOptions[]) {
				expect(option, `${String(option.value)} action`).toHaveProperty('action');
				expect(option, `${String(option.value)} description`).toHaveProperty('description');
			}
		}
	});

	// n8n's copy rule for booleans, and `@n8n/eslint-plugin-community-nodes` enforces it.
	it('starts every boolean description with "Whether"', () => {
		for (const property of [...flatten(action.properties), ...flatten(trigger.properties)]) {
			if (property.type !== 'boolean' || !property.description) continue;
			expect(property.description.startsWith('Whether'), `${property.name}`).toBe(true);
		}
	});

	// `no-emoji-in-options`.
	it('puts no emoji in any option name or displayName', () => {
		const emoji = /\p{Extended_Pictographic}/u;
		for (const property of [...flatten(action.properties), ...flatten(trigger.properties)]) {
			expect(emoji.test(property.displayName ?? ''), `${property.name}`).toBe(false);
			for (const option of (property.options ?? []) as INodePropertyOptions[]) {
				expect(emoji.test(String(option.name ?? '')), `${property.name}`).toBe(false);
			}
		}
	});

	// `no-credential-reuse`: a node may only reference credentials defined in this package.
	it('references only the credential this package defines', () => {
		for (const credential of [...(action.credentials ?? []), ...(trigger.credentials ?? [])]) {
			expect(credential.name).toBe(new CosendApi().name);
		}
	});

	it('ships a credential with a test, an icon and a password-typed key field', () => {
		const credential = new CosendApi();
		// `credential-test-required`
		expect(credential.test).toBeDefined();
		// `cred-class-field-icon-missing`
		expect(credential.icon).toBeDefined();

		const apiKey = credential.properties.find((property) => property.name === 'apiKey');
		// `credential-password-field`
		expect(apiKey?.typeOptions?.password).toBe(true);
		expect(apiKey?.required).toBe(true);
	});

	/**
	 * The credential test must hit an endpoint that cannot fail for authorization reasons.
	 * `/v1/me` declares `scopes: []` and A2 §5.1 guarantees it "never fails for authorization
	 * reasons" — a test against a scoped endpoint would tell someone with a valid but narrow key
	 * that their credential is broken.
	 */
	it('tests the credential against the unscoped /me endpoint', () => {
		expect(new CosendApi().test.request.url).toBe('/me');
	});

	it('references icons that exist and differ between light and dark', () => {
		// `icon-validation` is supposed to cover this. **It does not** — planting two identical
		// icon files and running `pnpm lint` produced no diagnostic at all, so this assertion is
		// the only thing standing between us and a submission rejected for it.
		expect(lightIcon).not.toBe(darkIcon);
		expect(lightIcon.length).toBeGreaterThan(0);
		for (const icon of [action.icon, trigger.icon] as { light: string; dark: string }[]) {
			expect(icon.light.startsWith('file:')).toBe(true);
			expect(icon.dark.startsWith('file:')).toBe(true);
			expect(icon.light).not.toBe(icon.dark);
		}
	});
});

describe('package.json', () => {
	// `no-runtime-dependencies` — the single biggest verification constraint (D7).
	it('has no runtime dependencies', () => {
		expect((packageJson as { dependencies?: object }).dependencies).toBeUndefined();
	});

	// `valid-peer-dependencies`
	it('declares only n8n-workflow as a peer dependency', () => {
		expect(Object.keys(packageJson.peerDependencies)).toEqual(['n8n-workflow']);
	});

	// `n8n-object-validation`
	it('points every registered node and credential at compiled files under dist/', () => {
		expect(packageJson.n8n.n8nNodesApiVersion).toBe(1);
		const registered = [...packageJson.n8n.nodes, ...packageJson.n8n.credentials];
		expect(registered.length).toBeGreaterThan(0);
		for (const path of registered) {
			expect(path.startsWith('dist/'), path).toBe(true);
			expect(path.endsWith('.js'), path).toBe(true);
		}
	});

	// `node-registration-complete`: every *.node.ts under nodes/ must be registered.
	it('registers both node classes', () => {
		expect(packageJson.n8n.nodes).toContain('dist/nodes/Cosend/Cosend.node.js');
		expect(packageJson.n8n.nodes).toContain('dist/nodes/CosendTrigger/CosendTrigger.node.js');
	});

	it('carries the metadata the verification gate checks', () => {
		expect(packageJson.name.startsWith('n8n-nodes-')).toBe(true);
		// D6: "Make sure your package license is MIT." Not optional.
		expect(packageJson.license).toBe('MIT');
		expect(packageJson.keywords).toContain('n8n-community-node-package');
		expect(packageJson.description).toBeTruthy();
		expect(packageJson.author.name).toBeTruthy();
		expect(packageJson.author.email).toBeTruthy();
		expect(packageJson.homepage).toMatch(/^https?:\/\//);
		expect(packageJson.files).toEqual(['dist']);
	});

	// `no-forbidden-lifecycle-scripts`. `prepublishOnly` is NOT on the ban list.
	it('declares no forbidden lifecycle script', () => {
		const forbidden = [
			'prepare',
			'preinstall',
			'install',
			'postinstall',
			'prepublish',
			'preprepare',
			'postprepare',
		];
		for (const script of forbidden) {
			expect(Object.keys(packageJson.scripts)).not.toContain(script);
		}
	});

	// `no-template-placeholders`
	it('leaves no unresolved template placeholder', () => {
		expect(JSON.stringify(packageJson)).not.toMatch(/\{\{|<your|n8n-nodes-\.\.\./);
	});
});

describe('the product rules the API enforces', () => {
	/**
	 * **Standing rule 3 and A2 §5.5, in one assertion.**
	 *
	 * `settableControl` is `pending_human | human`. `bot` is absent because decision C9 makes
	 * handover one-way — *"A human cannot send something to an AI through a click. It's one
	 * way."* `app` is absent because it is observed, not set, and A2 answers
	 * `400 control_app_is_observed` to an attempt.
	 *
	 * Doc 03 §4.3 specifies the dropdown as `Bot / Pending Human / Human`. Transcribing it would
	 * have offered a guaranteed error AND broken the product rule Ramee stated in his own words.
	 */
	it('offers no Bot and no App in the conversation control dropdown', () => {
		const control = flatten(action.properties).find(
			(property) =>
				property.name === 'control' &&
				property.displayOptions?.show?.operation?.includes('setControl'),
		);
		const values = ((control?.options ?? []) as INodePropertyOptions[]).map((option) =>
			String(option.value),
		);

		expect(values.sort()).toEqual(['human', 'pending_human']);
	});

	/**
	 * Filtering by `app` is the opposite case and must stay: it is how a workflow finds the
	 * conversations the owner is handling from their own phone, which is the whole coexistence
	 * proposition. Only SETTING it is refused.
	 */
	it('still allows filtering conversations by App control', () => {
		const filter = flatten(action.properties).find(
			(property) => property.name === 'control' && property.routing?.send?.type === 'query',
		);
		const values = ((filter?.options ?? []) as INodePropertyOptions[]).map((option) =>
			String(option.value),
		);

		expect(values).toContain('app');
		expect(values).toContain('bot');
	});

	/**
	 * The API accepts `kind: 'recurring'` in zod and refuses it in the service with
	 * `recurring_schedules_not_available` (plan NOTIFY-6). A Kind dropdown offering Recurring
	 * would be a dropdown entry that cannot run — standing rule 9.
	 */
	it('offers no recurring schedule anywhere in the schedule resource', () => {
		const scheduleProperties = flatten(action.properties).filter((property) =>
			property.displayOptions?.show?.resource?.includes('schedule'),
		);

		expect(scheduleProperties.length).toBeGreaterThan(0);
		for (const property of scheduleProperties) {
			for (const option of (property.options ?? []) as INodePropertyOptions[]) {
				expect(String(option.value)).not.toBe('recurring');
			}
			expect(property.name).not.toMatch(/rrule/i);
		}
	});

	/**
	 * `reaction` is a legal value of the API's `messageType` enum, and `React` is its own
	 * operation on its own endpoint. Offering both would be two ways to do one thing, which n8n's
	 * UX guidelines and CLAUDE.md both forbid.
	 */
	it('does not offer Reaction as a Send message type', () => {
		expect(optionValues(action.properties, 'messageType')).not.toContain('reaction');
	});

	// Every message type offered must be one the API's `messageType` enum accepts.
	it('offers only message types the API accepts', () => {
		const accepted = [
			'text',
			'image',
			'audio',
			'video',
			'document',
			'sticker',
			'location',
			'contacts',
			'interactive',
			'template',
			'reaction',
		];
		for (const type of optionValues(action.properties, 'messageType')) {
			expect(accepted, type).toContain(type);
		}
	});

	/**
	 * **Catches: a dotted body path that relies on an undocumented default.**
	 *
	 * `template.name` and `quiet_hours.start` are meant to build nested objects. n8n has an
	 * explicit `propertyInDotNotation` flag for that, and neither `n8n-workflow`'s types nor its
	 * schemas state what happens when it is omitted. If the default is ever `false`, these send
	 * `{"template.name": "..."}` — a literal key — into a `.strict()` schema, which is a `400` on
	 * every single call to `Notification: Send` and `Schedule: Create`.
	 *
	 * The flag is therefore declared explicitly everywhere a path contains a dot, and this test
	 * stops the next person adding one without it. Relying on the default was the alternative, and
	 * it is unverifiable from anything installed here.
	 */
	it('declares dot notation explicitly on every dotted body path', () => {
		const dotted = flatten(action.properties).filter((property) => {
			const send = property.routing?.send;
			return (
				send?.type === 'body' && typeof send.property === 'string' && send.property.includes('.')
			);
		});

		expect(dotted.length, 'there are dotted body paths to check').toBeGreaterThan(0);
		for (const property of dotted) {
			expect(
				property.routing?.send?.propertyInDotNotation,
				`${property.name} -> ${String(property.routing?.send?.property)}`,
			).toBe(true);
		}
	});

	// `settableControl`'s siblings: the state enum the API declares, and nothing else.
	it('offers only conversation states the API accepts', () => {
		const accepted = ['open', 'pending', 'snoozed', 'resolved'];
		for (const property of flatten(action.properties)) {
			if (property.name !== 'state') continue;
			for (const option of (property.options ?? []) as INodePropertyOptions[]) {
				expect(accepted, String(option.value)).toContain(String(option.value));
			}
		}
	});
});
