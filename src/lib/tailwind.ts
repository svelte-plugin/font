// ============================================================================
// src/lib/tailwind.ts — Tailwind v4 awareness + CSS-variable name resolution
// Pure functions. The dependency check reads package.json synchronously.
// ============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TailwindMode, FontCategory, NormalizedFont } from './options.js';
import type { ResolvedFont } from './resolve.js';

/**
 * Decide whether Tailwind v4 CSS-variable injection is active.
 * - true  -> always on
 * - false -> always off
 * - 'auto' -> on iff 'tailwindcss' is listed in package.json deps/devDeps
 */
export function detectTailwind(opts: { tailwind: TailwindMode; root: string }): boolean {
	if (opts.tailwind === true) return true;
	if (opts.tailwind === false) return false;
	// 'auto': sniff package.json for a tailwindcss dependency.
	const pkgPath = join(opts.root, 'package.json');
	if (!existsSync(pkgPath)) return false;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		return Boolean(pkg.dependencies?.tailwindcss || pkg.devDependencies?.tailwindcss);
	} catch {
		// Malformed package.json: treat as "no tailwind" rather than throwing.
		return false;
	}
}

/**
 * Map a font category to the Tailwind v4 custom property that its
 * font-sans/serif/mono utilities compile to.
 */
export function categoryToVar(
	category: FontCategory,
): '--font-sans' | '--font-serif' | '--font-mono' {
	switch (category) {
		case 'serif':
			return '--font-serif';
		case 'mono':
			return '--font-mono';
		default:
			return '--font-sans';
	}
}

/**
 * Resolve the CSS custom property name a font maps to.
 * DEFAULT is the category var (--font-sans/serif/mono) — which is exactly the
 * Tailwind v4 var — and the user can override it per font via `cssVariable`.
 */
export function resolveCssVariable(font: NormalizedFont | ResolvedFont): string {
	return font.cssVariable ?? categoryToVar(font.category);
}

/** Per-family handle, e.g. "Open Sans" -> "--font-open-sans". */
export function perFamilyVar(family: string): string {
	return '--font-' + kebab(family);
}

/** lowercase, spaces -> '-', strip anything outside [a-z0-9-]. */
function kebab(name: string): string {
	const slug = name
		.normalize('NFKD') // decompose accents: é -> e + combining mark
		.replace(/[̀-ͯ]/g, '') // strip the combining marks
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	// A fully non-ASCII name (e.g. CJK) collapses to '' — fall back to a stable
	// hash so the var stays non-empty and distinct families don't all collide on
	// `--font-`.
	return slug || `f-${hashSlug(name)}`;
}

/** djb2 -> base36; stable per-name slug fallback for non-ASCII family names. */
function hashSlug(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	return h.toString(36);
}
