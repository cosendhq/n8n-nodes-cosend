/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

/**
 * The templates in `templates/` against n8n's template rules (docs.n8n.io/contribute/create-templates/,
 * its submission guidelines and its sticky-note guidelines, as read on 9 Nov 2026):
 *
 * - One main overview note: yellow, top-left, 100 to 300 words, with the headings "### How it works"
 *   and "### Setup" ("### Customization" is optional).
 * - A workflow of 4 or more nodes also has section notes: white, each under 50 words, with a "## "
 *   heading. A red note, held to the same length and heading, warns about a critical setup step.
 * - A template using a community node names the package, the version tested, and links to its
 *   installation instructions. Each overview carries the Setup line of the n8n.io template brief
 *   (6 Nov 2026): "version tested 0.2.0; install guide at cosend.app/docs/n8n".
 * - No credentials and no pinned data.
 */

/** n8n's sticky-note colours, by the index a workflow stores: 1 is yellow (the default), 3 red, 7 white. */
const YELLOW = 1;
const RED = 3;
const WHITE = 7;
const INSTALL_GUIDE = 'cosend.app/docs/n8n';

type Node = {
	name: string;
	type: string;
	position: number[];
	parameters: { content?: string; color?: number; width?: number; height?: number };
	credentials?: unknown;
};
type Workflow = { nodes: Node[]; pinData?: Record<string, unknown> };

const STICKY = 'n8n-nodes-base.stickyNote';
// Every file in templates/, so a new template is checked without anyone listing it. Vite's glob,
// not `node:fs`: the community-nodes linter refuses `node:fs` in tests too.
const templates = Object.entries(
	import.meta.glob<Workflow>('../templates/*.json', { eager: true, import: 'default' }),
).map(([path, workflow]): [string, Workflow] => [path.replace('../templates/', ''), workflow]);

/** Words a reader sees: link targets, list numbers and markdown marks are not words. */
function words(markdown: string): number {
	return markdown
		.replace(/\]\([^)]*\)/g, ']')
		.replace(/^\s*\d+\.\s/gm, '')
		.split(/\s+/)
		.filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

// A note saved with n8n's default colour carries no `color` at all, and n8n draws it yellow.
const isOverview = (node: Node) =>
	node.type === STICKY && (node.parameters.color ?? YELLOW) === YELLOW;

describe('the templates', () => {
	it('are all found', () => {
		expect(templates.map(([file]) => file).sort()).toEqual([
			'google-sheets-to-whatsapp.json',
			'log-phone-replies-to-google-sheets.json',
			'receive-whatsapp-messages.json',
			'whatsapp-ai-agent.json',
			'whatsapp-window-alert-to-slack.json',
		]);
	});

	describe.each(templates)('%s', (_file, workflow) => {
		const stickies = workflow.nodes.filter((node) => node.type === STICKY);
		const steps = workflow.nodes.filter((node) => node.type !== STICKY);
		const overviews = stickies.filter(isOverview);
		const sections = stickies.filter((node) => !isOverview(node));

		it('has one yellow overview note, at the top left of everything and covering nothing', () => {
			expect(overviews).toHaveLength(1);
			const [overview] = overviews;
			const [left, top] = overview.position;
			const right = left + (overview.parameters.width ?? 0);
			const bottom = top + (overview.parameters.height ?? 0);
			for (const node of workflow.nodes.filter((other) => other !== overview)) {
				const [x, y] = node.position;
				expect(left, `${node.name} is left of the overview`).toBeLessThan(x);
				expect(top, `${node.name} is above the overview`).toBeLessThanOrEqual(y);
				expect(x >= right || y >= bottom, `${node.name} is under the overview`).toBe(true);
			}
		});

		it('says how it works and how to set it up, in 100 to 300 words', () => {
			const content = overviews[0].parameters.content ?? '';
			expect(content).toContain('### How it works');
			expect(content).toContain('### Setup');
			expect(content.indexOf('### How it works')).toBeLessThan(content.indexOf('### Setup'));
			expect(words(content)).toBeGreaterThanOrEqual(100);
			expect(words(content)).toBeLessThanOrEqual(300);
		});

		it('names the community node, the version tested and how to install it', () => {
			const content = overviews[0].parameters.content ?? '';
			expect(content).toContain('n8n-nodes-cosend');
			expect(content).toMatch(/version tested \d+\.\d+\.\d+/);
			expect(content).toContain(INSTALL_GUIDE);
		});

		it('has white section notes, and red warnings, under 50 words, each with a heading', () => {
			if (steps.length >= 4) {
				expect(sections.filter((note) => note.parameters.color === WHITE).length).toBeGreaterThan(0);
			}
			for (const note of sections) {
				const content = note.parameters.content ?? '';
				expect([WHITE, RED], note.name).toContain(note.parameters.color);
				expect(content, note.name).toMatch(/^## \S/);
				expect(words(content), note.name).toBeLessThan(50);
			}
		});

		it('carries no credentials and no pinned data', () => {
			expect(workflow.nodes.filter((node) => node.credentials !== undefined)).toEqual([]);
			expect(workflow.pinData ?? {}).toEqual({});
		});
	});
});
