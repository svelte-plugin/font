// ============================================================================
// src/lib/css.ts — FINAL CSS ASSEMBLER
// Emits valid CSS only (no JS): per-font @font-face blocks, fallback override
// @font-face blocks (precomputed by metrics.ts via fontaine), and one :root
// block mapping each font's CSS variable to its joined family stack.
// ============================================================================
import { resolveCssVariable, perFamilyVar } from './tailwind.js';
import type { ResolvedFont } from './resolve.js';
import type { FallbackResult } from './metrics.js';
import type { NormalizedOptions, FamilyName } from './options.js';
import type {
  FontFaceData,
  LocalFontSource,
  RemoteFontSource,
} from 'unifont';

// ---------------------------------------------------------------------------
// Small CSS-value helpers
// ---------------------------------------------------------------------------

/** A src entry is a LocalFontSource iff it carries a `name`. */
function isLocal(
  src: LocalFontSource | RemoteFontSource,
): src is LocalFontSource {
  return 'name' in src;
}

/** Quote a family name for use in a CSS value when it contains whitespace. */
function wrapQuote(name: string): string {
  return /\s/.test(name) ? `"${name}"` : name;
}

/** Render a single font-weight descriptor value. Range tuple -> "<min> <max>". */
function weightValue(weight: FontFaceData['weight']): string | undefined {
  if (weight === undefined) return undefined;
  if (Array.isArray(weight)) return `${weight[0]} ${weight[1]}`;
  return String(weight);
}

/** Render the `src:` value by joining each source entry. */
function srcValue(src: FontFaceData['src']): string {
  return src
    .map((s) => {
      if (isLocal(s)) return `local("${s.name}")`;
      // RemoteFontSource: url("...") [format("...")]. Quote the url so a family/
      // file name containing ( ) ' (which encodeURIComponent leaves intact) can't
      // break the declaration.
      return s.format
        ? `url("${s.url}") format("${s.format}")`
        : `url("${s.url}")`;
    })
    .join(', ');
}

/** Emit one @font-face block for a single resolved face. */
function fontFaceBlock(
  family: FamilyName,
  face: FontFaceData,
  defaultDisplay: string,
): string {
  const lines: string[] = [];
  lines.push(`  font-family: "${family}";`);
  lines.push(`  src: ${srcValue(face.src)};`);

  const weight = weightValue(face.weight);
  if (weight !== undefined) lines.push(`  font-weight: ${weight};`);

  lines.push(`  font-style: ${face.style ?? 'normal'};`);
  lines.push(`  font-display: ${face.display ?? defaultDisplay};`);

  if (face.unicodeRange && face.unicodeRange.length) {
    lines.push(`  unicode-range: ${face.unicodeRange.join(', ')};`);
  }
  if (face.variationSettings) {
    lines.push(`  font-variation-settings: ${face.variationSettings};`);
  }

  return `@font-face {\n${lines.join('\n')}\n}`;
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

export async function buildFontCss(args: {
  resolved: ResolvedFont[];
  fallbacks: Map<FamilyName, FallbackResult>;
  tailwindEnabled: boolean;
  options: NormalizedOptions;
}): Promise<string> {
  const { resolved, fallbacks, tailwindEnabled, options } = args;
  const blocks: string[] = [];

  // 1 + 2: per-font web @font-face blocks, then fallback override blocks.
  for (const font of resolved) {
    for (const face of font.faces) {
      blocks.push(fontFaceBlock(font.family, face, options.display));
    }
    const fb = fallbacks.get(font.family);
    if (fb && fb.fallbackCss) blocks.push(fb.fallbackCss);
  }

  // 3: one :root block of CSS variables.
  const rootLines: string[] = [];
  for (const font of resolved) {
    const fb = fallbacks.get(font.family);
    // Fall back to just the family if metrics.ts produced no stack (defensive).
    const stack = fb?.stack ?? [font.family];
    const value = stack.map(wrapQuote).join(', ');

    // Per-family var (ALWAYS). Rewritten `font-family` usages point here, and
    // it's a collision-free handle for every font.
    const fam = perFamilyVar(font.family);
    rootLines.push(`  ${fam}: ${value};`);

    // Category var (--font-sans/serif/mono) or an explicit override — emitted by
    // default so Tailwind utilities resolve; skipped only when tailwind:false and
    // no explicit cssVariable. Same-category fonts collide here (last wins).
    const primary = resolveCssVariable(font);
    if (primary !== fam && (tailwindEnabled || font.cssVariable)) {
      rootLines.push(`  ${primary}: ${value};`);
    }
  }

  const rootBlock = [
    '/* Per-font CSS variables. --font-<family> is always set (rewritten',
    '   font-family usages reference it). The category var (--font-sans/serif/',
    '   mono) is also set by default for Tailwind; set `cssVariable` to override. */',
    ':root {',
    ...rootLines,
    '}',
  ].join('\n');

  blocks.push(rootBlock);

  return blocks.join('\n\n') + '\n';
}
