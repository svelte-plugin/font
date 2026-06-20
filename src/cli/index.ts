// ============================================================================
// src/cli/index.ts — the bin entrypoint for `npx @svelte-plugin/font`.
//
// NOTE: no `#!/usr/bin/env node` shebang in this source file. esbuild preserves
// a source-level shebang verbatim, so combining it with the build's
// `--banner:js='#!/usr/bin/env node'` produces a DUPLICATE shebang on line 2 —
// a SyntaxError when the bundle runs. The banner alone guarantees a single
// shebang on line 1 of dist/cli.js. Local `node src/cli/index.ts` needs no
// shebang (Node is invoked explicitly).
//
// Interactive setup CLI that configures an EXISTING SvelteKit/Vite project:
// locate vite config -> install the plugin -> pick cdn/self-host -> pick fonts
// -> idempotently edit the vite config -> print next steps.
//
// Flags override prompts; when stdout/stdin aren't a TTY (or --yes), defaults
// are used and nothing prompts. esbuild re-asserts the shebang via --banner.
// ============================================================================
import { parseArgs } from 'node:util';
import { resolve, relative } from 'node:path';
import * as p from '@clack/prompts';

import { getFontChoices, resolveFontNames, categoryHint } from './registry.ts';
import { perFamilyVar, categoryToVar } from '../lib/tailwind.ts';
import {
	SOURCE_DEFAULT,
	findViteConfig,
	editViteConfig,
	type ConfigEditResult,
} from './config.ts';
import {
	type PackageManager,
	detectPackageManager,
	readProjectPkg,
	hasDep,
	installCommand,
	formatCommand,
	installDevDep,
} from './pm.ts';

const PKG = '@svelte-plugin/font';
const PACKAGE_MANAGERS: PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];
const SOURCES = ['cdn', 'download'] as const;

export type Flags = {
	fonts?: string[];
	source?: 'cdn' | 'download';
	pm?: PackageManager;
	yes: boolean;
	skipInstall: boolean;
	cwd: string;
	dryRun: boolean;
	help: boolean;
};

const USAGE = `
${PKG} — interactive setup for an existing SvelteKit/Vite project

Usage:
  npx ${PKG} [options]

Options:
  --fonts=A,B,C       Comma-separated Google (or local) family names. Empty -> rely on auto-detect.
  --source=cdn|download   Load from the Google CDN (default) or self-host woff2 into static/hosted_fonts.
  --pm=npm|pnpm|yarn|bun  Package manager to install with (default: detected from lockfile).
  -y, --yes           Accept defaults and skip confirmations.
  --skip-install      Don't install ${PKG}; print the command instead.
  --cwd=PATH          Project directory (default: current directory).
  --dry-run           Print the edited vite config without writing or installing.
  -h, --help          Show this help.

Example:
  npx ${PKG} --fonts=Inter,Roboto --source=download
`;

/**
 * Parse + normalize argv into Flags. Throws on an invalid --source/--pm value or
 * (via parseArgs strict) an unknown flag; the caller prints usage and exits 1.
 */
export function parseFlags(argv: string[]): Flags {
	const { values } = parseArgs({
		args: argv,
		options: {
			fonts: { type: 'string' },
			source: { type: 'string' },
			pm: { type: 'string' },
			yes: { type: 'boolean', short: 'y' },
			'skip-install': { type: 'boolean' },
			cwd: { type: 'string' },
			'dry-run': { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: false,
		strict: true,
	});

	// fonts: undefined => not provided (will prompt). '' / only commas => [] =>
	// explicitly empty, do NOT prompt. Split, trim, drop empties.
	let fonts: string[] | undefined;
	if (values.fonts !== undefined) {
		fonts = values.fonts
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	let source: 'cdn' | 'download' | undefined;
	if (values.source !== undefined) {
		if (!SOURCES.includes(values.source as (typeof SOURCES)[number])) {
			throw new Error(`Invalid --source '${values.source}'. Expected 'cdn' or 'download'.`);
		}
		source = values.source as 'cdn' | 'download';
	}

	let pm: PackageManager | undefined;
	if (values.pm !== undefined) {
		if (!PACKAGE_MANAGERS.includes(values.pm as PackageManager)) {
			throw new Error(`Invalid --pm '${values.pm}'. Expected one of ${PACKAGE_MANAGERS.join(', ')}.`);
		}
		pm = values.pm as PackageManager;
	}

	return {
		fonts,
		source,
		pm,
		yes: Boolean(values.yes),
		skipInstall: Boolean(values['skip-install']),
		cwd: resolve((values.cwd as string | undefined) ?? process.cwd()),
		dryRun: Boolean(values['dry-run']),
		help: Boolean(values.help),
	};
}

/** Unwrap a clack prompt result, exiting cleanly on cancel (Ctrl-C / Esc). */
function ok<T>(value: T | symbol): T {
	if (p.isCancel(value)) {
		p.cancel('Setup cancelled.');
		process.exit(0);
	}
	return value as T;
}

async function main(): Promise<void> {
	let flags: Flags;
	try {
		flags = parseFlags(process.argv.slice(2));
	} catch (err) {
		console.error((err as Error).message);
		console.log(USAGE);
		process.exit(1);
	}

	if (flags.help) {
		console.log(USAGE);
		process.exit(0);
	}

	const { cwd } = flags;
	const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY && !flags.yes);

	p.intro(`${PKG} setup`);

	// 1. LOCATE the vite config (guidance error if missing).
	const configPath = findViteConfig(cwd);
	if (!configPath) {
		p.log.error(
			`No vite.config.{ts,js,mjs} found in ${cwd}.\n` +
				`Run this inside a SvelteKit/Vite project, or pass --cwd=PATH.`,
		);
		p.outro('Nothing to do.');
		process.exit(1);
	}

	// 2. INSTALL the plugin (unless already a dep).
	const pkgInfo = readProjectPkg(cwd);
	if (pkgInfo && hasDep(pkgInfo.json, PKG)) {
		p.log.info(`${PKG} already installed.`);
	} else {
		const pm: PackageManager =
			flags.pm ??
			(interactive
				? ok(
						await p.select<PackageManager>({
							message: 'Package manager?',
							options: PACKAGE_MANAGERS.map((m) => ({ value: m, label: m })),
							initialValue: detectPackageManager(cwd) ?? 'npm',
						}),
					)
				: (detectPackageManager(cwd) ?? 'npm'));

		const command = formatCommand(pm, installCommand(pm, PKG, true));

		let shouldInstall: boolean;
		if (flags.skipInstall || flags.dryRun) {
			shouldInstall = false;
		} else if (interactive) {
			shouldInstall = ok(
				await p.confirm({ message: `Install ${PKG} with ${pm}?`, initialValue: true }),
			);
		} else {
			shouldInstall = true; // non-TTY / --yes: proceed.
		}

		if (shouldInstall) {
			const s = p.spinner();
			s.start(`Installing ${PKG} with ${pm}…`);
			const r = installDevDep({ pm, pkg: PKG, cwd, dryRun: false });
			s.stop(r.ok ? `Installed ${PKG}.` : 'Install failed.');
			if (!r.ok) {
				if (r.reason) p.log.warn(r.reason);
				p.log.warn(`Install it manually: ${command}`);
			}
		} else {
			p.log.info(`Skipped install. Run: ${command}`);
		}
	}

	// 3. SOURCE: self-host (download) vs CDN (default).
	const source: 'cdn' | 'download' =
		flags.source ??
		(interactive
			? ok(
					await p.confirm({
						message: 'Self-host fonts? (download woff2 into static/hosted_fonts)',
						initialValue: false,
					}),
				)
				? 'download'
				: 'cdn'
			: SOURCE_DEFAULT);

	// 4. FONT PICKER (may be empty -> rely on auto-detect).
	let fonts: string[];
	if (flags.fonts !== undefined) {
		const { fonts: resolved, unknown } = resolveFontNames(flags.fonts);
		if (unknown.length) {
			p.log.warn(
				`Not in the Google registry (kept as local families): ${unknown.join(', ')}`,
			);
		}
		fonts = resolved;
	} else if (interactive) {
		fonts = ok(
			await p.autocompleteMultiselect<string>({
				message: 'Search Google fonts (optional — leave empty to rely on auto-detect)',
				options: getFontChoices(),
				required: false,
				maxItems: 10,
			}),
		);
	} else {
		fonts = []; // non-TTY default: rely on auto-detect.
	}

	// 4b. PER-FONT CSS VARIABLE. Preselect the category var (--font-sans/serif/
	// mono); the user may pick any custom property. We persist `cssVariable` when
	// it differs from the category default, OR when there's no Tailwind to map the
	// category var (so the chosen var is always emitted). Only prompt for fonts
	// chosen via the interactive picker (a --fonts run keeps the category default).
	type Pick = { family: string; category: 'sans' | 'serif' | 'mono'; cssVariable?: string };
	const tailwind = pkgInfo ? hasDep(pkgInfo.json, 'tailwindcss') : false;
	const pickedInteractively = flags.fonts === undefined && interactive;
	const picks: Pick[] = [];
	for (const family of fonts) {
		const category = categoryHint(family) ?? 'sans';
		const defVar = categoryToVar(category);
		let chosen: string = defVar;
		if (pickedInteractively) {
			chosen = ok(
				await p.text({
					message: `CSS variable for ${family}?`,
					initialValue: defVar,
					validate: (v) =>
						/^--[A-Za-z0-9-]+$/.test((v ?? '').trim())
							? undefined
							: 'Must be a CSS custom property, e.g. --font-display',
				}),
			).trim();
		}
		const cssVariable = chosen !== defVar || !tailwind ? chosen : undefined;
		picks.push({ family, category, ...(cssVariable ? { cssVariable } : {}) });
	}

	// 4c. INLINE the stylesheet into the SSR <head> (default true: no layout shift
	// on slow networks). Written as `inline: false` only when declined.
	const inline = interactive
		? ok(
				await p.confirm({
					message: 'Inline the font CSS into the SSR <head>? (avoids layout shift on slow networks)',
					initialValue: true,
				}),
			)
		: true;

	// 5. EDIT the vite config (idempotent).
	let res: ConfigEditResult;
	try {
		res = await editViteConfig({ configPath, fonts: picks, source, inline, dryRun: flags.dryRun });
	} catch (err) {
		p.log.error((err as Error).message);
		p.outro('Could not update the vite config.');
		process.exit(1);
	}

	if (flags.dryRun) {
		p.note(res.code, `${relative(cwd, configPath) || configPath} (dry run — not written)`);
	} else {
		const verb =
			res.action === 'added' ? 'Added' : res.action === 'updated' ? 'Updated' : 'Left unchanged';
		p.log.success(`${verb} font() in ${relative(cwd, configPath) || configPath}`);
	}

	// 6. CSS VARIABLES the user can reference now. Every font exposes a per-family
	// var (--font-<family>, always set); the selected/category var is listed too.
	if (picks.length) {
		const rows = picks.map((pk) => {
			const sel = pk.cssVariable ?? categoryToVar(pk.category);
			const fam = perFamilyVar(pk.family);
			const util =
				tailwind && sel === categoryToVar(pk.category) ? `   (or Tailwind: font-${pk.category})` : '';
			return `${pk.family}\n  var(${sel})${util}\n  var(${fam})`;
		});
		p.note(rows.join('\n\n'), 'CSS variables you can use');
	}

	// 7. OUTRO with next steps.
	const labelled = picks
		.map((pk) => `${pk.family} (${categoryHint(pk.family) ?? 'local'})`)
		.join(', ');

	const steps = [
		'Import nothing — fonts are injected automatically.',
		source === 'download'
			? 'woff2 files will be written to static/hosted_fonts on the next build.'
			: 'Fonts load from the Google CDN.',
		inline
			? 'CSS is inlined into the SSR <head> (no layout shift on slow networks).'
			: 'CSS loads as a separate stylesheet (inline: false).',
		'Run your dev server: npm run dev',
		picks.length === 0
			? 'No fonts picked — auto-detect will scan src/ for used families.'
			: `Configured: ${labelled}`,
	];
	p.note(steps.join('\n'), 'Next steps');
	p.outro('Done.');
}

main().catch((err) => {
	p.log.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
