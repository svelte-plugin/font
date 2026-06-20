// Standalone self-check for src/cli/config.ts.
//
// Run with: node src/cli/config.selfcheck.ts   (Node 24 strips the TS types)
//
// Writes temp vite configs, exercises addFontToViteConfig, and asserts
// idempotency, correct insertion ordering, and the empty-args UPDATE path.
// Never imported by index.ts; never an esbuild entry.

import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addFontToViteConfig, editViteConfig } from './config.ts';

const FIXTURE = `import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
});
`;

const assert = (cond: boolean, msg: string): void => {
	if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`);
};
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

async function selfCheck(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'svelte-font-cli-'));
	const cfg = join(dir, 'vite.config.ts');
	writeFileSync(cfg, FIXTURE, 'utf8');

	try {
		// --- First run: adds the plugin + import.
		const r1 = await addFontToViteConfig({
			cwd: dir,
			fonts: ['Inter', 'JetBrains Mono'],
			source: 'download',
			dryRun: false,
		});
		assert(r1.action === 'added', `expected action 'added', got '${r1.action}'`);

		const after1 = readFileSync(cfg, 'utf8');
		assert(
			count(after1, `import font from '@svelte-plugin/font'`) === 1 ||
				count(after1, `import font from "@svelte-plugin/font"`) === 1,
			'import should appear exactly once after first run',
		);
		assert(count(after1, 'font(') === 1, 'font(...) should appear exactly once after first run');
		assert(after1.includes('Inter') && after1.includes('JetBrains Mono'), 'fonts should be present');
		assert(
			after1.includes(`source: 'download'`) || after1.includes(`source: "download"`),
			'source: download should be present',
		);

		// Ordering: font() must precede sveltekit() (and tailwindcss()).
		const iFont = after1.indexOf('font(');
		const iSvelte = after1.indexOf('sveltekit(');
		const iTw = after1.indexOf('tailwindcss(');
		assert(iFont >= 0 && iSvelte > iFont, 'font() must come before sveltekit()');
		assert(iFont >= 0 && iTw > iFont, 'font() must come before tailwindcss()');

		// --- Second run, SAME inputs: idempotent (no dup import / plugin).
		const r2 = await addFontToViteConfig({
			cwd: dir,
			fonts: ['Inter', 'JetBrains Mono'],
			source: 'download',
			dryRun: false,
		});
		assert(r2.action === 'updated', `second run expected 'updated', got '${r2.action}'`);

		const after2 = readFileSync(cfg, 'utf8');
		const importCount =
			count(after2, `import font from '@svelte-plugin/font'`) +
			count(after2, `import font from "@svelte-plugin/font"`);
		assert(importCount === 1, `import must appear once after re-run, found ${importCount}`);
		assert(count(after2, 'font(') === 1, 'font(...) must appear once after re-run');
		assert(after2 === after1, 'idempotent re-run must produce byte-identical output');

		// --- Bare re-run (no intent): leaves config unchanged.
		const r3 = await addFontToViteConfig({ cwd: dir, fonts: [], source: 'cdn', dryRun: false });
		assert(r3.action === 'unchanged', `bare re-run expected 'unchanged', got '${r3.action}'`);
		assert(readFileSync(cfg, 'utf8') === after2, 'bare re-run must not modify the file');

		// --- Fresh config + bare run => emits `font()` with no args.
		const cfg2 = join(dir, 'bare');
		mkdirSync(cfg2);
		writeFileSync(join(cfg2, 'vite.config.ts'), FIXTURE, 'utf8');
		const r4 = await addFontToViteConfig({ cwd: cfg2, fonts: [], source: 'cdn', dryRun: false });
		assert(r4.action === 'added', `fresh bare run expected 'added', got '${r4.action}'`);
		const bare = readFileSync(join(cfg2, 'vite.config.ts'), 'utf8');
		assert(/font\(\s*\)/.test(bare), 'bare run should emit font() with no args');

		// --- CRITICAL: bare font() THEN later picks must actually write the picks
		// (regression for the empty-args UPDATE no-op).
		const r4b = await addFontToViteConfig({
			cwd: cfg2,
			fonts: ['Inter', 'Roboto'],
			source: 'download',
			dryRun: false,
		});
		assert(r4b.action === 'updated', `empty->picks expected 'updated', got '${r4b.action}'`);
		const bare2 = readFileSync(join(cfg2, 'vite.config.ts'), 'utf8');
		assert(bare2.includes('Inter') && bare2.includes('Roboto'), 'empty font() must gain the picks');
		assert(
			bare2.includes(`source: 'download'`) || bare2.includes(`source: "download"`),
			'empty font() must gain source: download',
		);

		// --- UPDATE preserves a hand-tuned key (autoDetect).
		const cfg5 = join(dir, 'tuned');
		mkdirSync(cfg5);
		writeFileSync(
			join(cfg5, 'vite.config.ts'),
			`import font from '@svelte-plugin/font';\nimport { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [font({ autoDetect: false })] });\n`,
			'utf8',
		);
		const r6 = await addFontToViteConfig({ cwd: cfg5, fonts: ['Inter'], source: 'cdn', dryRun: false });
		assert(r6.action === 'updated', `tuned update expected 'updated', got '${r6.action}'`);
		const tuned = readFileSync(join(cfg5, 'vite.config.ts'), 'utf8');
		assert(tuned.includes('autoDetect'), 'update must preserve autoDetect');
		assert(tuned.includes('Inter'), 'update must add Inter');
		assert(count(tuned, 'import font from') === 1, 'no duplicate import on update');

		// --- dry-run does not write.
		const cfg3 = join(dir, 'dry');
		mkdirSync(cfg3);
		writeFileSync(join(cfg3, 'vite.config.ts'), FIXTURE, 'utf8');
		const r5 = await addFontToViteConfig({ cwd: cfg3, fonts: ['Roboto'], source: 'cdn', dryRun: true });
		assert(r5.code.includes('font('), 'dry-run code should contain font(');
		assert(
			readFileSync(join(cfg3, 'vite.config.ts'), 'utf8') === FIXTURE,
			'dry-run must not write the file',
		);

		// --- Missing config => clear error.
		const cfg4 = join(dir, 'empty');
		mkdirSync(cfg4);
		let threw = false;
		try {
			await addFontToViteConfig({ cwd: cfg4, fonts: [], source: 'cdn', dryRun: true });
		} catch {
			threw = true;
		}
		assert(threw, 'missing config should throw a clear error');

		// --- No default export => guidance error (not an opaque TypeError).
		const cfg6 = join(dir, 'nodefault');
		mkdirSync(cfg6);
		const noDefaultPath = join(cfg6, 'vite.config.ts');
		writeFileSync(noDefaultPath, `export const plugins = [];\n`, 'utf8');
		let guidance = '';
		try {
			await editViteConfig({ configPath: noDefaultPath, fonts: ['Inter'], source: 'cdn', dryRun: true });
		} catch (e) {
			guidance = (e as Error).message;
		}
		assert(guidance.includes('default export'), `no-default-export should give guidance, got: ${guidance}`);

		// --- NEW: per-font cssVariable + inline:false serialize into the config.
		const cfg7 = join(dir, 'vars');
		mkdirSync(cfg7);
		const varsPath = join(cfg7, 'vite.config.ts');
		writeFileSync(varsPath, FIXTURE, 'utf8');
		const r7 = await editViteConfig({
			configPath: varsPath,
			fonts: ['Roboto', { family: 'Inter', cssVariable: '--font-display' }],
			source: 'cdn',
			inline: false,
			dryRun: false,
		});
		assert(r7.action === 'added', `vars run expected 'added', got '${r7.action}'`);
		const vars = readFileSync(varsPath, 'utf8');
		assert(
			vars.includes(`cssVariable: '--font-display'`) || vars.includes(`cssVariable: "--font-display"`),
			'cssVariable should serialize into the object entry',
		);
		assert(/family:\s*['"]Inter['"]/.test(vars), 'object entry should carry family: Inter');
		assert(vars.includes('Roboto'), 'bare string entry (no cssVariable) should remain a string');
		assert(/inline:\s*false/.test(vars), 'inline: false should serialize');

		// inline:true (the plugin default) must NOT write the key.
		const cfg8 = join(dir, 'inline-default');
		mkdirSync(cfg8);
		const inlPath = join(cfg8, 'vite.config.ts');
		writeFileSync(inlPath, FIXTURE, 'utf8');
		await editViteConfig({ configPath: inlPath, fonts: ['Inter'], source: 'cdn', inline: true, dryRun: false });
		assert(!/inline/.test(readFileSync(inlPath, 'utf8')), 'inline:true must be omitted (plugin default)');

		console.log('config.ts self-check: ALL PASSED');
		console.log('--- final config ---\n' + after1);
		console.log('--- vars config ---\n' + vars);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

selfCheck().catch((err) => {
	console.error(err);
	process.exit(1);
});
