// Proof that the packed tarball, installed into a clean directory, loads and runs
// the way n8n's community-package loader loads it. No repo source is referenced —
// everything below resolves from node_modules/n8n-nodes-cosend only.
//
// Usage: from a directory where the tarball is installed alongside n8n-workflow —
//   pnpm pack --pack-destination <dir> && cd <fresh dir>
//   pnpm init && pnpm add <dir>/n8n-nodes-cosend-<version>.tgz n8n-workflow
//   node <path to this script>
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Resolve from the CALLER's directory, so the script can live in the repo while
// the package under test is whatever the current directory has installed.
const require_ = createRequire(path.join(process.cwd(), 'noop.js'));
const pkgRoot = path.dirname(require_.resolve('n8n-nodes-cosend/package.json'));
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
};

// ── 1. The n8n block declares files that exist in the installed package ────────
check('package.json has an n8n block', typeof pkg.n8n === 'object' && pkg.n8n !== null);
check('n8nNodesApiVersion is 1', pkg.n8n.n8nNodesApiVersion === 1);
check('no runtime dependencies', pkg.dependencies === undefined);
for (const rel of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) {
	check(`declared file exists: ${rel}`, existsSync(path.join(pkgRoot, rel)));
}

// ── 2. Load each node the way n8n's PackageDirectoryLoader does ────────────────
// (require the compiled file, take the export named after the file, instantiate)
const loadClass = (rel) => {
	const abs = path.join(pkgRoot, rel);
	const mod = require_(abs);
	const className = path.basename(rel).split('.')[0];
	const Cls = mod[className];
	if (typeof Cls !== 'function') throw new Error(`no export ${className} in ${rel}`);
	return { instance: new Cls(), abs };
};

const { instance: action, abs: actionPath } = loadClass('dist/nodes/Cosend/Cosend.node.js');
const d = action.description;
check('Cosend node instantiates', typeof d === 'object');
check("displayName 'Cosend'", d.displayName === 'Cosend');
check("name 'cosend'", d.name === 'cosend');
check('version 1', d.version === 1);
check('usableAsTool (n8n AI-agent tool surface)', d.usableAsTool === true);
check('declares subtitle', typeof d.subtitle === 'string' && d.subtitle.length > 0);
check(
	"credential 'cosendApi' required",
	Array.isArray(d.credentials) && d.credentials.some((c) => c.name === 'cosendApi' && c.required),
);
check('no execute() — declarative', typeof action.execute !== 'function');
check('customOperations present', typeof action.customOperations === 'object');

// icons referenced with file: paths must resolve relative to the compiled file
const iconOf = (icon) => (typeof icon === 'string' ? { light: icon, dark: icon } : icon);
for (const [variant, ref] of Object.entries(iconOf(d.icon))) {
	const rel = ref.replace(/^file:/, '');
	check(
		`action icon (${variant}) resolves`,
		existsSync(path.resolve(path.dirname(actionPath), rel)),
		rel,
	);
}
const icons = iconOf(d.icon);
check(
	'light and dark icons are different files',
	readFileSync(
		path.resolve(path.dirname(actionPath), icons.light.replace(/^file:/, '')),
	).toString() !==
		readFileSync(
			path.resolve(path.dirname(actionPath), icons.dark.replace(/^file:/, '')),
		).toString(),
);

// resource / operation surface: 6 resources, 20 operations
const resourceProp = d.properties.find((p) => p.name === 'resource');
check('6 resources', resourceProp?.options?.length === 6, `got ${resourceProp?.options?.length}`);
const operationProps = d.properties.filter((p) => p.name === 'operation');
const totalOps = operationProps.reduce((n, p) => n + (p.options?.length ?? 0), 0);
check('20 operations', totalOps === 20, `got ${totalOps}`);
for (const p of operationProps) {
	for (const op of p.options ?? []) {
		const declarative = op.routing !== undefined;
		const custom = Object.values(action.customOperations ?? {}).some((ops) => op.value in ops);
		check(
			`operation runnable: ${p.displayOptions?.show?.resource?.[0]}:${op.value}`,
			declarative || custom,
			declarative ? 'routing' : custom ? 'customOperation' : 'NEITHER',
		);
	}
}

// ── 3. The trigger node ────────────────────────────────────────────────────────
const { instance: trigger, abs: triggerPath } = loadClass(
	'dist/nodes/CosendTrigger/CosendTrigger.node.js',
);
const td = trigger.description;
check('CosendTrigger instantiates', typeof td === 'object');
check("trigger name 'cosendTrigger'", td.name === 'cosendTrigger');
check('trigger displayName contains Trigger', /Trigger/.test(td.displayName));
check('trigger inputs are []', Array.isArray(td.inputs) && td.inputs.length === 0);
check('webhooks array declared', Array.isArray(td.webhooks) && td.webhooks.length === 1);
for (const m of ['checkExists', 'create', 'delete']) {
	check(`webhookMethods.default.${m}`, typeof trigger.webhookMethods?.default?.[m] === 'function');
}
check('webhook() implemented', typeof trigger.webhook === 'function');
const eventsProp = td.properties.find((p) => p.name === 'events');
check(
	'23 trigger events offered',
	eventsProp?.options?.length === 23,
	`got ${eventsProp?.options?.length}`,
);
for (const [variant, ref] of Object.entries(iconOf(td.icon))) {
	const rel = ref.replace(/^file:/, '');
	check(
		`trigger icon (${variant}) resolves`,
		existsSync(path.resolve(path.dirname(triggerPath), rel)),
		rel,
	);
}

// ── 4. The credential ──────────────────────────────────────────────────────────
const { instance: cred } = loadClass('dist/credentials/CosendApi.credentials.js');
check("credential name 'cosendApi'", cred.name === 'cosendApi');
check(
	'bearer auth from apiKey',
	JSON.stringify(cred.authenticate).includes('Bearer {{$credentials.apiKey}}'),
);
check('credential test hits /me', cred.test?.request?.url === '/me');
const apiKeyProp = cred.properties.find((p) => p.name === 'apiKey');
check('apiKey is a password field', apiKeyProp?.typeOptions?.password === true);

// ── 5. Run real compiled code from the installed package ───────────────────────
const { verifyCosendSignature } = require_(
	path.join(pkgRoot, 'dist/nodes/CosendTrigger/signature.js'),
);
const secret = 'whsec_proof';
const body = '{"event":"ping"}';
const now = 1_756_300_000;
const sig = (s, t) => createHmac('sha256', s).update(`${t}.${body}`).digest('hex');
check(
	'HMAC verifier accepts a valid signature',
	verifyCosendSignature(body, `t=${now},v1=${sig(secret, now)}`, secret, now) === true,
);
check(
	'HMAC verifier rejects a wrong secret',
	verifyCosendSignature(body, `t=${now},v1=${sig('wrong', now)}`, secret, now) === false,
);
check(
	'HMAC verifier rejects a stale timestamp',
	verifyCosendSignature(body, `t=${now - 301},v1=${sig(secret, now - 301)}`, secret, now) === false,
);
check(
	'HMAC verifier accepts the second v1= (secret rotation)',
	verifyCosendSignature(
		body,
		`t=${now},v1=${sig('old', now)},v1=${sig(secret, now)}`,
		secret,
		now,
	) === true,
);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
