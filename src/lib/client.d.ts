// Ambient declaration so `import 'virtual:font.css'` typechecks in consumer code
// (e.g. src/routes/+layout.svelte). The plugin serves this module at build/dev.
declare module 'virtual:font.css';

// Runtime access to the fonts the plugin resolved, plus a SvelteKit handle for
// a font chosen per request (e.g. from the user's session). Served by the plugin.
declare module 'virtual:font' {
	export interface FontManifestEntry {
		/** Per-family CSS variable holding the font + its metric-matched fallback, e.g. "--font-roboto". */
		variable: string;
		/** woff2 urls to preload for this font (latin subset preferred). */
		preload: string[];
	}

	/**
	 * Every font the plugin resolved (declared, auto-detected, local), keyed by family
	 * name. Missing keys are `undefined` — always fall back when indexing with user input.
	 */
	export const fonts: Readonly<Record<string, FontManifestEntry | undefined>>;

	/**
	 * The font family to use per slot. Each key sets `--font-<key>`: `sans`, `serif`
	 * and `mono` are Tailwind's `font-sans/serif/mono`; any other name works too
	 * (`display` -> `--font-display`), and a key starting with `--` is used as-is.
	 */
	export interface FontChoices {
		sans?: string | null;
		serif?: string | null;
		mono?: string | null;
		[slot: string]: string | null | undefined;
	}

	/** A family name (shorthand for `{ sans: family }`), per-slot choices, or nothing. */
	export type FontPick = string | FontChoices | null | undefined;

	/**
	 * SvelteKit `handle` that applies and preloads the fonts `pick` returns for the
	 * request: sets each slot's variable on `<html>` and adds `Link: rel=preload`
	 * headers. `pick` runs lazily, once, only for HTML pages (after load functions).
	 * Families that aren't resolved fonts are skipped; none leaves the page untouched.
	 *
	 * @example
	 * export const handle = fontHandle(({ locals }) => ({
	 *   sans: locals.user?.sans,
	 *   serif: locals.user?.serif,
	 *   mono: locals.user?.mono,
	 * }));
	 */
	export function fontHandle(
		pick: (event: import('@sveltejs/kit').RequestEvent) => FontPick | Promise<FontPick>,
	): import('@sveltejs/kit').Handle;
}
