// ============================================================================
// src/cli/config.ts — Vite-config locator + idempotent editor (magicast).
//
// The critical, testable core of the setup CLI. Self-contained: imports only
// node builtins and magicast. NO @clack/prompts, NO font registry — pure config
// surgery so it can be unit-tested in isolation.
// ============================================================================
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadFile, writeFile, generateCode, type ProxifiedModule } from 'magicast';
import { addVitePlugin, findVitePluginCall, getDefaultExportOptions } from 'magicast/helpers';

/**
 * The magicast module shape we work with. `Record<string, any>` exports keeps
 * `mod.exports.default` accessible in TS (loadFile's default `Exports` resolves
 * to a bare `object`, which doesn't expose the index signature).
 */
type ViteModule = ProxifiedModule<Record<string, any>>;

/** Shared default source (re-used by index.ts + the flag parser). */
export const SOURCE_DEFAULT = 'cdn' as const;

/** Plugin identity, used both to import and to detect an existing call. */
const PLUGIN_FROM = '@svelte-plugin/font';
const PLUGIN_IMPORTED = 'default';
const PLUGIN_CTOR = 'font';

/**
 * Callees that should ALWAYS run after font() in the plugins array. font() is
 * inserted immediately before the first of these so its transforms see Tailwind
 * / SvelteKit output. (Order chosen to match the documented behaviour.)
 */
const RUN_AFTER_FONT = ['tailwindcss', 'sveltekit', 'svelte'];

export type ConfigEditResult = {
	action: 'added' | 'updated' | 'unchanged';
	/** Full generated source — for --dry-run printing and for diffing. */
	code: string;
	path: string;
};

/**
 * Locate the Vite config under `cwd`. Checks, in order:
 * vite.config.ts -> vite.config.js -> vite.config.mjs.
 * Returns the absolute path, or null when none exists (index.ts turns null into
 * the guidance error).
 */
export function findViteConfig(cwd: string): string | null {
	for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
		const p = join(cwd, name);
		if (existsSync(p)) return p;
	}
	return null;
}

/**
 * Build the options object that should serialize as the plugin's args:
 * - empty `fonts`  -> omit the key (rely on auto-detect)
 * - source 'cdn'   -> omit the key (plugin default applies)
 * So a bare run yields `font()`, a download+picks run yields
 * `font({ fonts: ['A','B'], source: 'download' })`.
 */
function buildOptions(fonts: string[], source: 'cdn' | 'download'): Record<string, unknown> {
	const options: Record<string, unknown> = {};
	if (fonts.length) options.fonts = fonts;
	if (source !== SOURCE_DEFAULT) options.source = source;
	return options;
}

/**
 * Guard the default export shape before handing the module to magicast helpers.
 * getDefaultExportOptions / findVitePluginCall dereference `mod.exports.default`,
 * which is `undefined` when the config has no `export default` — magicast then
 * throws an opaque `TypeError: Cannot read properties of undefined (reading
 * '$type')`. Convert that into actionable guidance up front.
 */
function assertDefaultExport(mod: ViteModule, configPath: string): void {
	if (!mod.exports?.default) {
		throw new Error(
			`${configPath} has no default export (or an unsupported config shape). ` +
				`Expected \`export default defineConfig({ plugins: [...] })\` (or a default-exported config object). ` +
				`Add font() to your plugins array manually.`,
		);
	}
}

/**
 * Locate the existing font() call (if any), tolerant of how it was imported.
 *
 * The primary lookup keys on the import { from, imported } -> local name, which
 * covers the import we add. As a real fallback (not the dead string-arg form,
 * which magicast treats as a `from` path), scan the plugins array for any call
 * whose callee is literally `font` — so a `font` imported from a different
 * package is still detected and we never add a duplicate `import font`.
 */
function findExisting(mod: ViteModule) {
	const byImport = findVitePluginCall(mod, { from: PLUGIN_FROM, imported: PLUGIN_IMPORTED });
	if (byImport) return byImport;

	const plugins = getDefaultExportOptions(mod)?.plugins;
	if (plugins && typeof plugins.find === 'function') {
		return plugins.find(
			(p: any) => p && p.$type === 'function-call' && p.$callee === PLUGIN_CTOR,
		);
	}
	return undefined;
}

/**
 * Idempotently add (or update) the `font()` plugin in an already-located Vite
 * config. configPath is absolute (from findViteConfig).
 *
 * Idempotency:
 * - Not present  -> ADD, inserted before tailwindcss()/sveltekit()/svelte().
 * - Present, no new intent (fonts empty + source 'cdn') -> leave as-is.
 * - Present, with intent -> merge fonts/source into existing args (never
 *   clobbering other hand-tuned keys like autoDetect).
 * Re-running with the same inputs produces byte-identical output; magicast
 * dedupes the import; the plugin is never inserted twice.
 */
export async function editViteConfig(args: {
	configPath: string;
	fonts: string[];
	source: 'cdn' | 'download';
	dryRun: boolean;
}): Promise<ConfigEditResult> {
	const { configPath, fonts, source, dryRun } = args;

	let mod: ViteModule;
	try {
		mod = await loadFile<Record<string, any>>(configPath);
	} catch (err) {
		throw new Error(
			`Could not parse ${configPath}: ${(err as Error).message}. ` +
				`Add font() to your plugins array manually.`,
		);
	}

	// Convert magicast's opaque TypeErrors (missing/unsupported default export,
	// non-array plugins, etc.) into actionable guidance.
	try {
		assertDefaultExport(mod, configPath);

		// Function-form configs (`defineConfig(() => ({ ... }))`) expose no editable
		// plugins array — getDefaultExportOptions returns the arrow function, so
		// addVitePlugin would add a dangling `import font` with no font() call. Bail
		// with guidance instead of writing a broken config.
		if ((getDefaultExportOptions(mod) as { $type?: string })?.$type !== 'object') {
			throw new Error(
				`${configPath} uses a function-form Vite config ` +
					`(e.g. \`defineConfig(() => ({ ... }))\`), which can't be edited automatically. ` +
					`Add it manually: \`import font from '@svelte-plugin/font'\` and put ` +
					`\`font()\` first in the returned \`plugins\` array.`,
			);
		}

		const options = buildOptions(fonts, source);
		const existing = findExisting(mod);

		let action: ConfigEditResult['action'];

		if (!existing) {
			// ---- ADD --------------------------------------------------------------
			// Compute the insertion index so font() lands before tailwindcss/sveltekit.
			const opts = getDefaultExportOptions(mod);
			const plugins = opts.plugins;
			let index = 0;
			if (plugins && typeof plugins.findIndex === 'function') {
				const found = plugins.findIndex(
					(p: any) =>
						p && p.$type === 'function-call' && RUN_AFTER_FONT.includes(p.$callee),
				);
				index = found >= 0 ? found : 0; // prepend when neither present.
			}

			addVitePlugin(mod, {
				from: PLUGIN_FROM,
				imported: PLUGIN_IMPORTED,
				constructor: PLUGIN_CTOR,
				// undefined options -> magicast emits a bare `font()` (no empty `{}`).
				options: Object.keys(options).length ? options : undefined,
				index,
			});
			action = 'added';
		} else if (fonts.length === 0 && source === SOURCE_DEFAULT) {
			// ---- UNCHANGED --------------------------------------------------------
			// Already configured and the caller expressed no new intent: don't touch a
			// hand-tuned config.
			action = 'unchanged';
		} else {
			// ---- UPDATE -----------------------------------------------------------
			// Merge fonts/source onto the existing first arg, preserving every other
			// key (e.g. autoDetect). CRITICAL: when the existing call is a bare
			// `font()` (zero args), returning a new args array from the handler is a
			// no-op on magicast's getter-based $args proxy — the picks would be
			// silently discarded. So set $args[0] directly in that case; otherwise
			// mutate the existing arg object in place.
			if (existing.$args.length === 0) {
				existing.$args[0] = options;
			} else {
				const cur = existing.$args[0];
				if (fonts.length) cur.fonts = fonts;
				if (source !== SOURCE_DEFAULT) cur.source = source;
				else delete cur.source; // back to the plugin default.
			}
			action = 'updated';
		}

		const code = generateCode(mod).code;

		if (!dryRun && action !== 'unchanged') {
			await writeFile(mod, configPath);
		}

		return { action, code, path: configPath };
	} catch (err) {
		// Re-throw our own guidance errors untouched; wrap magicast internals.
		if (err instanceof Error && err.message.includes(configPath)) throw err;
		throw new Error(
			`Failed to edit ${configPath} (unsupported config shape: ${(err as Error).message}). ` +
				`Add font() to your plugins array manually.`,
		);
	}
}

/**
 * Convenience wrapper for the CLI entrypoint: locate the config under `cwd`
 * (throwing a clear, actionable error if none) then idempotently add/update
 * font(). Writes the file unless `dryRun`; returns the generated code either way.
 */
export async function addFontToViteConfig(args: {
	cwd: string;
	fonts: string[];
	source: 'cdn' | 'download';
	dryRun: boolean;
}): Promise<ConfigEditResult> {
	const configPath = findViteConfig(args.cwd);
	if (!configPath) {
		throw new Error(
			`No vite.config.{ts,js,mjs} found in ${args.cwd}. ` +
				`Run this inside a SvelteKit/Vite project, or pass --cwd=PATH.`,
		);
	}
	return editViteConfig({
		configPath,
		fonts: args.fonts,
		source: args.source,
		dryRun: args.dryRun,
	});
}
