// ============================================================================
// src/lib/metrics.ts — fontaine wrapper for CLS-reducing fallback @font-face.
// Produces metric-override @font-face blocks so the system fallback font
// occupies the same space as the web font (size-adjust + ascent/descent/
// line-gap overrides). The override math is done ENTIRELY by fontaine's
// generateFontFace — this module only orchestrates it.
// ============================================================================
import {
  getMetricsForFamily,
  readMetrics,
  generateFontFace,
  generateFallbackName,
  resolveCategoryFallbacks,
  DEFAULT_CATEGORY_FALLBACKS,
  type FontCategory as FontaineCategory,
} from 'fontaine';
import type { FontFaceData } from 'unifont';
import type { FontCategory, FamilyName } from './options.js';

export interface FallbackResult {
  /** Override @font-face block(s) for the fallback name; '' when metrics unknown. */
  fallbackCss: string;
  /** The override family name, e.g. "Inter fallback". */
  fallbackName: string;
  /** Full CSS font-family stack: [family, fallbackName?, ...systemFonts]. */
  stack: string[];
}

/** Our 3-bucket category -> fontaine's richer FontCategory union. */
const CATEGORY_MAP: Record<FontCategory, FontaineCategory> = {
  sans: 'sans-serif',
  serif: 'serif',
  mono: 'monospace',
};

/** First remote woff2 url across a font's faces, or undefined. */
function firstRemoteWoff2Url(faces: FontFaceData[]): string | undefined {
  for (const face of faces) {
    for (const src of face.src) {
      if ('url' in src) {
        const fmt = src.format ?? '';
        if (fmt.includes('woff2') || src.url.includes('woff2')) {
          // Prefer the original fetchable URL. In download mode the url is
          // rewritten to a protocol-less /fonts/x.woff2 that readMetrics can't
          // read; originalURL keeps the gstatic https URL.
          return src.originalURL ?? src.url;
        }
      }
    }
  }
  return undefined;
}

/** First on-disk (file://) src across faces, any format — for local self-hosted fonts. */
function firstLocalFileUrl(faces: FontFaceData[]): string | undefined {
  for (const face of faces) {
    for (const src of face.src) {
      if ('url' in src && src.originalURL?.startsWith('file:')) return src.originalURL;
    }
  }
  return undefined;
}

export async function buildFallback(args: {
  family: FamilyName;
  faces: FontFaceData[];
  category: FontCategory;
}): Promise<FallbackResult> {
  const { family, faces, category } = args;

  // Step 1: metrics from the @capsizecss DB, else download from the font binary
  // (variable-font / unknown-font path). Both may return null.
  let metrics = await getMetricsForFamily(family);
  if (!metrics) {
    // woff2 first (smallest remote download); for local fonts fall back to ANY
    // on-disk face (file://) since readMetrics reads ttf/otf/woff off disk too.
    const url = firstRemoteWoff2Url(faces) ?? firstLocalFileUrl(faces);
    if (url) {
      // A malformed / OS2-less binary must not crash the whole build/dev server.
      try {
        metrics = await readMetrics(url);
      } catch {
        metrics = null;
      }
    }
  }

  const fallbackName = generateFallbackName(family);

  // Step 2: pick the system fallback stack for this category. We stamp our
  // known category onto the metrics so resolveCategoryFallbacks selects by it
  // (rather than whatever fontaine happened to infer).
  const fontaineCategory = CATEGORY_MAP[category];
  const categoryFallbacks = resolveCategoryFallbacks({
    fontFamily: family,
    fallbacks: {}, // {} => fall through to category-based resolution
    metrics: { ...(metrics ?? {}), category: fontaineCategory },
    categoryFallbacks: DEFAULT_CATEGORY_FALLBACKS,
  });

  // Graceful: no metrics => no override @font-face; omit the override name from
  // the stack since nothing backs it. System fallbacks still apply.
  if (!metrics) {
    return {
      fallbackCss: '',
      fallbackName,
      stack: [family, ...categoryFallbacks],
    };
  }

  // One metric-override @font-face per system fallback font. fontaine derives
  // size-adjust from BOTH the web-font metrics AND each system font's own
  // metrics — so we MUST fetch and pass `metrics` for every system font.
  // Without it size-adjust stays 100% and there is zero width correction (i.e.
  // no CLS reduction, the whole point). System fonts with no known metrics are
  // skipped (matches fontaine's own transform behavior).
  const blocks = await Promise.all(
    categoryFallbacks.map(async (systemFont) => {
      const systemMetrics = await getMetricsForFamily(systemFont);
      if (!systemMetrics) return '';
      return generateFontFace(metrics, {
        name: fallbackName,
        font: systemFont,
        metrics: systemMetrics,
      });
    }),
  );
  const fallbackCss = blocks.filter(Boolean).join('\n');

  return {
    fallbackCss,
    fallbackName,
    stack: [family, fallbackName, ...categoryFallbacks],
  };
}
