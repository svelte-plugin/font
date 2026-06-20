// src/cli/registry.ts
//
// Thin, self-contained adapter over the bundled Google-font registry.
// Pure data only — NO @clack/prompts or magicast imports here. This keeps the
// 1936-name list out of every other CLI module's surface.
//
// The relative `.ts` extension is deliberate: these CLI modules are NOT shipped
// through svelte-package — esbuild bundles `../lib/generated/google-fonts.ts`
// straight into dist/cli.js, so npx needs no extra files at runtime. A `.ts`
// specifier resolves under BOTH Node 24 (type-stripping `node src/cli/...`) and
// esbuild; a `.js` specifier would NOT resolve to the on-disk `.ts` under Node.

import { GOOGLE_FONT_NAMES, googleFonts } from '../lib/generated/google-fonts.ts';

/**
 * The @clack/prompts `Option<string>` shape consumed by autocompleteMultiselect.
 * `value === label ===` the exact Google family name (spaces/case preserved,
 * which the plugin keys on).
 */
export type FontChoice = { value: string; label: string; hint?: string };

/**
 * Build the hint string shown next to a font in the picker:
 * `<category>` plus ` · variable` when the family ships a variable font.
 */
function buildHint(name: string): string | undefined {
	const meta = googleFonts[name as keyof typeof googleFonts];
	if (!meta) return undefined;
	return meta.category + (meta.variable ? ' · variable' : '');
}

// Built once at module load (1936 entries) and memoized in a module-level const.
// clack filters client-side, so we hand it the full list.
const FONT_CHOICES: FontChoice[] = GOOGLE_FONT_NAMES.map((name) => ({
	value: name,
	label: name,
	hint: buildHint(name),
}));

/**
 * Full list of picker options, one per GOOGLE_FONT_NAMES entry. Memoized.
 */
export function getFontChoices(): FontChoice[] {
	return FONT_CHOICES;
}

/**
 * Alias retained per the per-file spec wording ("export fontOptions()").
 * Identical to getFontChoices(); both return the same memoized array.
 */
export function fontOptions(): FontChoice[] {
	return FONT_CHOICES;
}

// Lazily-built case-insensitive lookup: lowercased family name -> canonical name.
let canonicalByLower: Map<string, string> | undefined;

function getCanonicalMap(): Map<string, string> {
	if (!canonicalByLower) {
		canonicalByLower = new Map();
		for (const name of GOOGLE_FONT_NAMES) {
			canonicalByLower.set(name.toLowerCase(), name);
		}
	}
	return canonicalByLower;
}

/**
 * Resolve raw `--fonts` CSV entries against the registry (case-INSENSITIVE).
 * Trims each input, drops empties, and matches `inter` -> `Inter`.
 *
 * Returns canonical names in `fonts`; anything with no registry match goes to
 * `unknown` (kept verbatim — a local family name is legal per options.ts where
 * `FamilyName = GoogleFontName | (string & {})`). The caller decides whether to
 * warn (strict) or pass the unknowns through.
 *
 * When `strict` is false (default), unknowns are also appended to `fonts` so the
 * caller can use the merged list directly; when `strict` is true, `fonts`
 * contains only canonical registry matches.
 */
export function resolveFontNames(
	input: string[],
	opts: { strict?: boolean } = {},
): { fonts: string[]; unknown: string[] } {
	const strict = opts.strict ?? false;
	const map = getCanonicalMap();
	const fonts: string[] = [];
	const unknown: string[] = [];

	for (const raw of input) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const canonical = map.get(trimmed.toLowerCase());
		if (canonical) {
			fonts.push(canonical);
		} else {
			unknown.push(trimmed);
			if (!strict) fonts.push(trimmed);
		}
	}

	// Dedupe, preserving first-seen order. Case variants collapse to one canonical
	// name (e.g. `Inter,inter,INTER` -> `['Inter']`), and repeated unknowns merge.
	// config.ts writes `fonts` verbatim into the user's vite.config, so dedup here.
	return { fonts: [...new Set(fonts)], unknown: [...new Set(unknown)] };
}

/**
 * Exact-key membership test against the registry. Used to label fonts in
 * dry-run output / notes. Case-sensitive by design (the plugin keys on the
 * exact family name).
 */
export function isGoogleFont(name: string): boolean {
	return Object.prototype.hasOwnProperty.call(googleFonts, name);
}

/**
 * Category hint for note/log output only. Returns undefined for non-Google
 * (local) families.
 */
export function categoryHint(name: string): 'sans' | 'serif' | 'mono' | undefined {
	return googleFonts[name as keyof typeof googleFonts]?.category;
}

// NOTE: there is intentionally NO direct-run self-check here. esbuild bundles
// this module into dist/cli.js, where any top-level `import.meta.url ===
// process.argv[1]` guard would fire on EVERY `npx @svelte-plugin/font` run
// (after bundling the entry's url IS this module's url), polluting stdout and
// possibly calling process.exit(1). The self-check lives in the standalone
// src/cli/registry.selfcheck.ts, which is never imported by index.ts and is
// never an esbuild entry — so it can never reach the shipped bin.
