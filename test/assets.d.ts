/**
 * Vite's `?raw` suffix, so `test/description.test.ts` can compare the two icon files without
 * `node:fs` — `no-restricted-imports` bans the filesystem, and a RELATIVE import is on the
 * allowlist. This declaration is test-only and never reaches `dist/`.
 */
declare module '*.svg?raw' {
	const content: string;
	export default content;
}
