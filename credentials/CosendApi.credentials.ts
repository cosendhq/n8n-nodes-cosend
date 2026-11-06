import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Doc 03 §4.5 / A0 §8.3.
 *
 * An API key, not OAuth2 — deliberate, and D5 records why: Cosend does run an OAuth 2.1 server,
 * but it is for MCP, scoped to agent consent, and it withholds `keys:write` and
 * `connections:write`. A workflow runs unattended and cannot complete a consent flow, so the
 * right credential is a long-lived revocable key. `CosendOAuth2Api` stays deferred.
 */
export class CosendApi implements ICredentialType {
	name = 'cosendApi';

	displayName = 'Cosend API';

	// `cred-class-field-icon-missing`. Paths are relative to the COMPILED file, which lands at
	// `dist/credentials/`, so one `..` reaches `dist/../icons` — the same shape n8n's own
	// templates use.
	icon: Icon = { light: 'file:../icons/cosend.svg', dark: 'file:../icons/cosend.dark.svg' };

	documentationUrl = 'https://cosend.app/docs/n8n#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'e.g. cok_live_…',
			// Least privilege is the default advice, and the two prefixes mean different blast
			// radii (A0 §8.3): a workspace key reaches every connected number, a connection key
			// reaches exactly one and cannot be pointed at another. "Workspace", as cosend.app/n8n
			// and SPEC §1 *Words* say it.
			description:
				'Create one in Cosend under Settings → API Keys. Use a workspace key (cok_live_…) for a workflow that touches several WhatsApp numbers, or a connection key (csk_live_…) when the workflow is about one number, because a connection key reaches that number only.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.cosend.app/v1',
			placeholder: 'e.g. https://api.cosend.app/v1',
			// The ONLY way to make the host configurable: `no-restricted-globals` bans `process`,
			// so there is no environment variable to read. cosend.app/docs/n8n: production is one
			// region, so the only other host to point at is a staging one.
			description: 'Change this only to point at a Cosend staging host',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	/**
	 * `credential-test-required`, and the cheapest onboarding win there is: a green tick before
	 * the user builds anything.
	 *
	 * `/me` is the right probe precisely because A2 §5.1 guarantees it "never fails for
	 * authorization reasons" — its route declares `scopes: []`, so any credential that resolves
	 * at all passes. A test against a scoped endpoint would fail for a *valid* key that simply
	 * lacks that scope, which teaches the user their key is broken when it is not.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/me',
			method: 'GET',
		},
	};
}
