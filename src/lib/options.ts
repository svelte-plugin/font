// ============================================================================
// src/lib/options.ts — PUBLIC + NORMALIZED OPTION TYPES
// All font entries are keyed by GoogleFontName for type-safe Google names.
// Defaults/normalization ONLY — no IO, no provider/fontaine calls.
// ============================================================================
import type {
  GoogleFontName,
  GoogleFontMeta,
} from "./generated/google-fonts.js";
import { googleFonts } from "./generated/google-fonts.js";

/**
 * Any resolved font family — a Google name OR a local family read from a binary.
 * Internal type (NormalizedFont / ResolvedFont / metrics / css). The PUBLIC
 * `FontEntry` uses `GoogleFontName` directly so declared fonts autocomplete and a
 * typo is a compile error; local families never flow through `FontEntry`.
 */
export type FamilyName = string;

export type FontCategory = "sans" | "serif" | "mono";
export type FontSource = "cdn" | "download";
export type FontProvider = "google"; // only google wired in v1; widen later
export type FontStyle = "normal" | "italic" | "oblique";
export type FontDisplay = "auto" | "block" | "swap" | "fallback" | "optional";
export type TailwindMode = boolean | "auto";

/** A single font request: bare family name, or an object with overrides. */
export type FontEntry =
  | GoogleFontName
  | {
      family: GoogleFontName;
      /**
       * Weights to resolve, e.g. [400, 700]. For VARIABLE fonts you normally omit
       * this — they default to their full `wght` axis range (one variable face
       * covering every weight). Static fonts default to 400. Pass a range string
       * like "100 900" to pin a custom variable range.
       */
      weights?: (number | string)[];
      /** Styles to resolve. Default: ['normal']. */
      styles?: FontStyle[];
      /** Subsets to resolve. Default: ['latin']. */
      subsets?: string[];
      /** Explicit CSS custom property name, e.g. "--font-display". Overrides tailwind/category var. */
      cssVariable?: string;
      /** Force a category (affects fallback stack + tailwind var). Default: inferred from registry. */
      category?: FontCategory;
      /** Emit a `<link rel="preload" as="font">` for this font's woff2 face(s). Default: false. */
      preload?: boolean;
    };

/** Public plugin options (what the user passes to the Vite plugin). */
export interface FontPluginOptions {
  /** Fonts to load. Optional — omit (or `font()`) to rely purely on auto-detect + local fonts. */
  fonts?: FontEntry[];
  /** Font CDN provider. Default: 'google'. */
  provider?: FontProvider;
  /** 'cdn' keeps gstatic urls; 'download' self-hosts to static/fonts. Default: 'cdn'. */
  source?: FontSource;
  /** Scan project source and ADD any used families that exist in the Google registry. Default: true. */
  autoDetect?: boolean;
  /** Tailwind v4 var injection. true | false | 'auto' (detect tailwindcss dep). Default: 'auto'. */
  tailwind?: TailwindMode;
  /** font-display descriptor for emitted @font-face. Default: 'swap'. */
  display?: FontDisplay;
  /** Static assets dir for downloads. Default: 'static'. */
  staticDir?: string;
  /** Auto-inject the generated CSS into the root +layout.svelte (no manual import). Default: true. */
  inject?: boolean;
  /** Rewrite `font-family: X` declarations in your CSS/<style> to inject the metric fallback. Default: true. */
  rewrite?: boolean;
  /** Write the generated stylesheet to `svelte-plugin-font.debug.css` for inspection. Default: false. */
  debug?: boolean;
  /**
   * Inline the generated stylesheet into the SSR `<head>` as a `<style>` instead
   * of importing it as a separate asset. Guarantees the `@font-face` metric
   * fallbacks + `:root` vars are present at first paint — no separate stylesheet
   * to wait on, so slow networks can't render the fallback at a later timing
   * (the CLS this plugin exists to prevent). Default: TRUE. Set `false` for a
   * linked/code-split stylesheet (smaller per-page HTML, but loads separately).
   * Only applies when `inject` is on.
   */
  inline?: boolean;
  /**
   * Local self-hosted fonts: the WHOLE <staticDir>/ is scanned RECURSIVELY (any
   * layout — no `fonts/` folder required). EVERY parseable font file becomes a
   * published webfont (@font-face + CSS var); use `exclude` to skip a dir of
   * fonts you don't want published. Family, weight, style, and variable range
   * are read from each binary via fontkit — filenames carry NO meaning. The
   * download dir (<staticDir>/hosted_fonts) is always skipped. Set false to
   * disable entirely. (Independent of `autoDetect`, which is Google-only.)
   */
  local?:
    | boolean // true (default): scan <staticDir>/ recursively; false: skip
    | {
        /** Per-family overrides keyed by the font's family name (read from the binary). */
        families?: Record<
          string,
          { category?: FontCategory; cssVariable?: string }
        >;
        /** Top-level dir names under <staticDir>/ to skip (e.g. ['og', 'assets']). */
        exclude?: string[];
      };
}

// ----------------------------------------------------------------------------
// Normalized internal shape (defaults filled). Other modules consume ONLY this.
// ----------------------------------------------------------------------------

/** One fully-resolved font request after normalization. */
export interface NormalizedFont {
  family: FamilyName;
  weights: string[]; // always string[] for unifont ResolveFontOptions.weights
  styles: FontStyle[]; // default ['normal']
  subsets: string[]; // default ['latin']
  category: FontCategory; // inferred from registry unless overridden
  cssVariable?: string; // explicit override only; resolved later by tailwind.ts
  preload: boolean; // emit <link rel="preload"> for this font's woff2 faces
}

export interface NormalizedOptions {
  fonts: NormalizedFont[];
  provider: FontProvider; // 'google'
  source: FontSource; // 'cdn' | 'download'
  autoDetect: boolean;
  tailwind: TailwindMode; // unresolved here; tailwind.ts resolves to boolean
  display: FontDisplay;
  staticDir: string; // 'static'
  inject: boolean; // auto-inject into the root layout
  rewrite: boolean; // rewrite font-family usages to inject the metric fallback
  debug: boolean; // dump the generated stylesheet to disk
  inline: boolean; // inline the stylesheet into the SSR <head>
  /**
   * Local self-hosted font scanning. `false` disables it; otherwise an object
   * holding per-family overrides (empty when none provided = scan enabled).
   */
  local:
    | false
    | {
        families: Record<
          string,
          { category?: FontCategory; cssVariable?: string }
        >;
        exclude: string[];
      };
}

/**
 * Fill defaults + normalize. Pure: no IO, no provider calls.
 * - bare-string entries -> objects
 * - numeric weights -> strings (String(w))
 * - category: entry.category ?? googleFonts[family].category ?? 'sans'
 * - missing weights -> [] (resolve.ts lets unifont apply provider defaults)
 */
export function normalizeOptions(
  user: FontPluginOptions = {},
): NormalizedOptions {
  const fonts = (user.fonts ?? []).map(normalizeFont);

  return {
    fonts,
    provider: user.provider ?? "google",
    source: user.source ?? "cdn",
    autoDetect: user.autoDetect ?? true,
    tailwind: user.tailwind ?? "auto",
    display: user.display ?? "swap",
    staticDir: user.staticDir ?? "static",
    inject: user.inject ?? true,
    rewrite: user.rewrite ?? true,
    debug: user.debug ?? false,
    inline: user.inline ?? true,
    // false -> disabled; object -> keep families/exclude; undefined/true -> enabled with empty overrides.
    local:
      user.local === false
        ? false
        : typeof user.local === "object"
          ? {
              families: user.local.families ?? {},
              exclude: user.local.exclude ?? [],
            }
          : { families: {}, exclude: [] },
  };
}

export function normalizeFont(entry: FontEntry): NormalizedFont {
  const obj = typeof entry === "string" ? { family: entry } : entry;
  const family = obj.family;
  // `family` may be a local directory name (not a GoogleFontName), so index via a
  // string view: a miss returns undefined and falls through to the local-safe defaults.
  const meta = (googleFonts as Record<string, GoogleFontMeta | undefined>)[
    family
  ];

  let weights = (obj.weights ?? []).map((w) => String(w));
  // Variable font + no explicit weights: request the full `wght` axis range as a
  // single "min max" token. unifont then returns ONE variable face
  // (font-weight: <min> <max>) covering every weight — instead of just 400.
  // You don't pick discrete weights for a variable font.
  if (weights.length === 0 && meta?.variable) {
    const wght = meta.axes.find((a) => a.tag === "wght");
    if (wght) weights = [`${wght.min} ${wght.max}`];
  }

  return {
    family,
    // numeric weights -> strings; static fonts with none stay [] so unifont uses its default (400).
    weights,
    styles: obj.styles ?? ["normal"],
    subsets: obj.subsets ?? ["latin"],
    // entry override -> registry category -> 'sans'. `meta` is undefined for local
    // families (absent from the registry), so the optional chain falls back to 'sans'.
    category: obj.category ?? meta?.category ?? "sans",
    preload: obj.preload ?? false,
    ...(obj.cssVariable ? { cssVariable: obj.cssVariable } : {}),
  };
}
