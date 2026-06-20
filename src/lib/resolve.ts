// ============================================================================
// src/lib/resolve.ts — unifont wrapper
// Creates (once, cached) a unifont instance with the google provider and
// resolves each normalized font into a structured per-family result.
// All heavy lifting (HTTP, caching, src-url generation) is unifont's; this
// module only adapts our NormalizedFont -> unifont call -> ResolvedFont.
// ============================================================================
import {
  createUnifont,
  providers,
  type FontFaceData,
  type Unifont,
} from 'unifont';
import type {
  NormalizedFont,
  FontProvider,
  FontCategory,
  FontDisplay,
  FamilyName,
} from './options.js';

export interface ResolvedFont {
  family: FamilyName;
  faces: FontFaceData[];
  category: FontCategory;
  variable: boolean;
  /** Explicit CSS variable override, carried through from NormalizedFont. */
  cssVariable?: string;
}

// The exact instance type, inferred from the provider tuple. We let TS infer it
// (rather than annotating Unifont<[Provider]>) because providers.google() yields
// the specific Provider<"google", GoogleFamilyOptions>, which is invariant and
// not assignable to the generic Provider — inference keeps resolveFont typed.
type GoogleUnifont = Awaited<ReturnType<typeof createGoogleUnifont>>;
function createGoogleUnifont(): Promise<Unifont<[ReturnType<typeof providers.google>]>> {
  return createUnifont([providers.google()]);
}

// Lazy, created once. createUnifont is async (it initializes the provider), so
// we cache the Promise and reuse it across all resolveFonts calls.
// ponytail: only the google provider is wired in v1 (matches FontProvider),
// CEILING: widening to bunny/fontsource/etc. means a provider registry here.
let unifontInstance: Promise<GoogleUnifont> | undefined;

function getUnifont(): Promise<GoogleUnifont> {
  if (!unifontInstance) {
    unifontInstance = createGoogleUnifont();
  }
  return unifontInstance;
}

export async function resolveFonts(args: {
  fonts: NormalizedFont[];
  // provider is accepted for forward-compat; only 'google' is wired (see getUnifont).
  provider: FontProvider;
  display: FontDisplay;
}): Promise<ResolvedFont[]> {
  const { fonts, display } = args;
  const unifont = await getUnifont();

  return Promise.all(
    fonts.map(async (font): Promise<ResolvedFont> => {
      // Omit empty arrays so unifont applies its defaultResolveOptions.
      const options: Partial<{
        weights: string[];
        styles: NormalizedFont['styles'];
        subsets: string[];
      }> = {};
      if (font.weights.length) options.weights = font.weights;
      if (font.styles.length) options.styles = font.styles;
      if (font.subsets.length) options.subsets = font.subsets;

      const result = await unifont.resolveFont(font.family, options);
      const faces = result.fonts;

      // css.ts emits font-display per face; stamp our configured default where
      // the provider didn't set one. (??= preserves any provider-supplied value.)
      for (const face of faces) {
        face.display ??= display;
      }

      // A weight expressed as a [min,max] tuple means a variable font.
      const variable = faces.some((f) => Array.isArray(f.weight));

      return {
        family: font.family,
        faces,
        category: font.category,
        variable,
        cssVariable: font.cssVariable,
      };
    }),
  );
}
