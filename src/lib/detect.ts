// ============================================================================
// src/lib/detect.ts — Auto-detection scanner
// Scans project source for font-family usages (CSS declarations + Tailwind
// arbitrary values) and returns the subset matching the registry.
// ============================================================================
import { readFile, glob } from 'node:fs/promises';
import { join } from 'node:path';
import { splitFontShorthand } from './rewrite.js';

/** Collapse internal whitespace to single spaces and trim. */
function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Shared family-equality helper (also used by plugin.ts): whitespace-normalized,
 * case-insensitive compare.
 */
export function eqFamily(a: string, b: string): boolean {
  return collapseWs(a).toLowerCase() === collapseWs(b).toLowerCase();
}

// Capture the value side of `font-family: <value>;` (stop at ; } { ).
const FONT_FAMILY_RE = /font-family\s*:\s*([^;}{]+)/gi;
// Tailwind arbitrary value: font-[Inter], font-[ "Open Sans" ], font-['Roboto Mono'].
const TAILWIND_ARB_RE = /font-\[\s*["']?([^\]"']+)["']?\s*\]/g;
// Tailwind @theme font vars: `--font-serif: "Playfair Display", serif`,
// `--font-display: Inter`, etc. The registry lookup filters non-font values
// (sizes, weights, feature-settings), so matching `--font-*` broadly is safe.
const THEME_FONT_RE = /--font[\w-]*\s*:\s*([^;}{]+)/gi;
// The `font` shorthand: `font: 700 2rem Inter`. Lookbehind avoids matching
// `font-family`/`font-weight`/`--x-font` etc. The family list is split off the
// rest by splitFontShorthand (everything after the size token).
const FONT_SHORTHAND_RE = /(?<![\w-])font\s*:\s*([^;}{]+)/gi;

/** Strip surrounding quotes from a single candidate token. */
function unquote(s: string): string {
  return s.trim().replace(/^["']|["']$/g, '');
}

/** Pull candidate family names out of one file's text. */
function collectCandidates(text: string): string[] {
  const out: string[] = [];

  let m: RegExpExecArray | null;
  while ((m = FONT_FAMILY_RE.exec(text)) !== null) {
    // Test EVERY family in the stack — `system-ui, Inter, sans-serif` must still
    // surface Inter. The registry lookup filters out generics like sans-serif.
    for (const tok of m[1].split(',')) out.push(unquote(tok));
  }
  while ((m = TAILWIND_ARB_RE.exec(text)) !== null) {
    // Tailwind uses underscores for spaces in arbitrary values: font-[Open_Sans].
    out.push(unquote(m[1].replace(/_/g, ' ')));
  }
  while ((m = THEME_FONT_RE.exec(text)) !== null) {
    // Tailwind @theme `--font-*` declarations — test every token in the stack.
    for (const tok of m[1].split(',')) out.push(unquote(tok));
  }
  while ((m = FONT_SHORTHAND_RE.exec(text)) !== null) {
    // `font` shorthand — only the trailing family list (after the size) counts.
    const split = splitFontShorthand(m[1]);
    if (split) for (const tok of split.family.split(',')) out.push(unquote(tok));
  }

  return out;
}

/**
 * Scan project source and return the canonical registry names that are used.
 * - Globs src/**\/*.{svelte,css,ts,js,pcss,scss} under `root`.
 * - Ignores node_modules and the generated virtual css.
 * - Matches candidates case-insensitively against `registryNames`, returning the
 *   CANONICAL registry spelling. De-duped, registry order preserved.
 */
export async function detectFonts(args: {
  root: string;
  registryNames: readonly string[];
  /** Absolute path prefixes to skip — e.g. the plugin's own dir so its example
   *  comments / the generated registry never count as "used" fonts. */
  ignore?: string[];
}): Promise<string[]> {
  const { root, registryNames, ignore = [] } = args;

  // Lowercased lookup -> canonical spelling, for fast case-insensitive matching.
  const canonical = new Map<string, string>();
  for (const name of registryNames) canonical.set(collapseWs(name).toLowerCase(), name);

  const found = new Set<string>(); // stores canonical spellings

  const entries = glob('src/**/*.{svelte,css,ts,js,pcss,scss}', { cwd: root });
  for await (const rel of entries) {
    if (rel.includes('node_modules')) continue;
    const abs = join(root, rel);
    if (ignore.some((d) => abs.startsWith(d))) continue;
    let text: string;
    try {
      text = await readFile(abs, 'utf8');
    } catch {
      continue; // file vanished mid-scan; skip
    }
    for (const cand of collectCandidates(text)) {
      const hit = canonical.get(collapseWs(cand).toLowerCase());
      if (hit) found.add(hit);
    }
  }

  // Return in registry order for determinism.
  return registryNames.filter((n) => found.has(n));
}

// ponytail: regex over `font-family`, Tailwind `font-[...]`, `@theme --font-*`,
// and the `font` shorthand — not a real parser. CEILING: misses computed/dynamic
// family names (template literals, JS-built class strings, `@apply`). UPGRADE
// PATH: swap the regex for css-tree (a transitive dep via unifont) and walk
// Declaration nodes.
