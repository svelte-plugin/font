// Standalone self-check for src/lib/font-module.ts (the `virtual:font` runtime).
//
// Run with: node src/lib/font-module.selfcheck.ts   (Node strips the TS types)
//
// Writes the generated module to a temp file, imports it, and drives fontHandle
// with a fake SvelteKit `resolve`. Excluded from the published package via
// package.json "files".

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fontModule } from './font-module.ts';

const assert = (cond: unknown, msg: string): void => {
	if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`);
};

const HTML = '<!doctype html><html lang="en"><head></head><body>hi</body></html>';
const LINK = (href: string) => `<${href}>; rel=preload; as=font; type="font/woff2"; crossorigin`;

type ChunkFn = (i: { html: string; done: boolean }) => unknown;
/** Fake SvelteKit page render: pushes each chunk through transformPageChunk. */
const render = (chunks: string[]) => async (_event: unknown, opts?: { transformPageChunk?: ChunkFn }) => {
	let body = '';
	for (const [i, html] of chunks.entries()) {
		body += (await opts?.transformPageChunk?.({ html, done: i === chunks.length - 1 })) ?? html;
	}
	return new Response(body, { headers: { 'content-type': 'text/html' } });
};
/** Fake endpoint / __data.json: never calls transformPageChunk. */
const endpoint = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });

async function selfCheck(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'svelte-font-module-'));
	try {
		const file = join(dir, 'virtual-font.mjs');
		writeFileSync(
			file,
			fontModule({
				Roboto: { variable: '--font-roboto', preload: ['https://cdn.test/roboto.woff2'] },
				Inter: {
					variable: '--font-inter',
					preload: ['https://cdn.test/inter-a.woff2', 'https://cdn.test/inter-b.woff2'],
				},
				'JetBrains Mono': { variable: '--font-jetbrains-mono', preload: ['https://cdn.test/mono.woff2'] },
			}),
			'utf8',
		);
		const { fonts, fontHandle } = await import(pathToFileURL(file).href);
		const run = (handle: any, resolve: any) => handle({ event: {}, resolve });

		// --- fonts: frozen, null prototype -> prototype keys never resolve.
		assert(fonts.Roboto.variable === '--font-roboto', 'fonts exposes entries');
		assert(Object.getPrototypeOf(fonts) === null && Object.isFrozen(fonts), 'fonts is frozen, null-prototype');
		assert(
			fonts.constructor === undefined && fonts['__proto__'] === undefined && fonts.toString === undefined,
			'prototype keys are undefined',
		);

		// --- Known family: <html style> + one Link per preload url, pick runs once.
		let calls = 0;
		let res = await run(
			fontHandle(() => (calls++, 'Inter')),
			render([HTML]),
		);
		let body = await res.text();
		assert(body.includes('<html style="--font-sans: var(--font-inter)" lang="en">'), `style injected: ${body}`);
		assert(
			res.headers.get('link') === `${LINK('https://cdn.test/inter-a.woff2')}, ${LINK('https://cdn.test/inter-b.woff2')}`,
			`Link headers: ${res.headers.get('link')}`,
		);
		assert(calls === 1, `pick runs once, got ${calls}`);

		// --- One font per category (async pick): all three vars in one style
		// attribute, in order, with every preload.
		res = await run(
			fontHandle(async () => ({ sans: 'Inter', serif: 'Roboto', mono: 'JetBrains Mono' })),
			render([HTML]),
		);
		body = await res.text();
		assert(
			body.includes(
				'<html style="--font-sans: var(--font-inter); --font-serif: var(--font-roboto); --font-mono: var(--font-jetbrains-mono)" lang="en">',
			),
			`three categories: ${body}`,
		);
		assert((res.headers.get('link') ?? '').split(', <').length === 4, `4 preloads: ${res.headers.get('link')}`);

		// --- Partial choices: unset / unknown / prototype slots are skipped, the rest apply.
		res = await run(
			fontHandle(() => ({ sans: null, serif: 'Roboto', mono: 'Nope', display: 'constructor' })),
			render([HTML]),
		);
		body = await res.text();
		assert(body.includes('<html style="--font-serif: var(--font-roboto)" lang="en">'), `partial: ${body}`);
		assert(res.headers.get('link') === LINK('https://cdn.test/roboto.woff2'), 'partial: only the applied font preloads');

		// --- Other slot names -> --font-<name>; `--` keys are used as-is.
		res = await run(fontHandle(() => ({ display: 'Roboto', '--brand': 'Inter' })), render([HTML]));
		assert(
			(await res.text()).includes('style="--font-display: var(--font-roboto); --brand: var(--font-inter)"'),
			'custom slots',
		);

		// --- Same font in two slots: preloaded once.
		res = await run(fontHandle(() => ({ sans: 'Roboto', serif: 'Roboto' })), render([HTML]));
		assert(res.headers.get('link') === LINK('https://cdn.test/roboto.woff2'), 'duplicate preloads deduped');

		// --- Unknown / empty / prototype keys / non-strings / arrays: untouched, no Link.
		for (const v of ['Nope', undefined, null, '', 'constructor', '__proto__', 'toString', 42, {}, ['Roboto']]) {
			res = await run(fontHandle(() => v), render([HTML]));
			assert((await res.text()) === HTML, `untouched for ${JSON.stringify(v)}`);
			assert(res.headers.get('link') === null, `no Link for ${JSON.stringify(v)}`);
		}

		// --- Existing style attribute on <html>: merged, never duplicated.
		res = await run(
			fontHandle(() => 'Roboto'),
			render(['<!doctype html><html lang="en" style="color: red"><body></body></html>']),
		);
		body = await res.text();
		assert(body.includes('<html lang="en" style="--font-sans: var(--font-roboto); color: red">'), `merged: ${body}`);
		assert((body.match(/style=/g) ?? []).length === 1, 'single style attribute');

		// --- Non-page responses (endpoints, __data.json): pick never runs, no Link.
		calls = 0;
		res = await run(
			fontHandle(() => (calls++, 'Roboto')),
			endpoint,
		);
		assert(calls === 0 && res.headers.get('link') === null, 'endpoint untouched, pick skipped');

		// --- Streamed page: pick once; only the document's <html> tag is styled.
		calls = 0;
		res = await run(
			fontHandle(() => (calls++, 'Roboto')),
			render(['<!doctype html><html lang="en"><body>', '<div><html data-later></div></body></html>']),
		);
		body = await res.text();
		assert(calls === 1, `streamed: pick once, got ${calls}`);
		assert(body.includes('<html style="--font-sans: var(--font-roboto)" lang="en">'), 'streamed: first chunk styled');
		assert(body.includes('<html data-later>'), 'streamed: later chunks not rewritten');

		// --- Resolver failure: contained (logged), page renders untouched.
		const origError = console.error;
		let logged = 0;
		console.error = () => void logged++;
		try {
			res = await run(
				fontHandle(() => {
					throw new Error('db down');
				}),
				render([HTML]),
			);
			assert((await res.text()) === HTML && res.headers.get('link') === null, 'sync throw contained');
			res = await run(
				fontHandle(async () => {
					throw new Error('db down');
				}),
				render([HTML]),
			);
			assert((await res.text()) === HTML, 'async rejection contained');
			assert(logged === 2, `failures logged, got ${logged}`);
		} finally {
			console.error = origError;
		}

		// --- Invalid keys (they'd land in an HTML attribute): skipped and logged; the
		// valid slots still apply.
		logged = 0;
		console.error = () => void logged++;
		try {
			res = await run(
				fontHandle(() => ({
					'x" onload="alert(1)': 'Roboto',
					'--x;color:red': 'Roboto',
					'a b': 'Roboto',
					serif: 'Inter',
				})),
				render([HTML]),
			);
			body = await res.text();
			assert(
				body.includes('<html style="--font-serif: var(--font-inter)" lang="en">') && !body.includes('onload'),
				`invalid keys skipped: ${body}`,
			);
			assert(logged === 3, `invalid keys logged, got ${logged}`);
		} finally {
			console.error = origError;
		}

		// (Composition with Kit's sequence() needs Kit's request store — it relies on the
		// style-attribute merge above and is exercised end-to-end in a real app.)

		console.log('font-module.ts self-check: ALL PASSED');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

selfCheck().catch((err) => {
	console.error(err);
	process.exit(1);
});
