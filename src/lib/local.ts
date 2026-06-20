// ============================================================================
// src/lib/local.ts — LOCAL (self-hosted) font scanner (BINARY-ONLY)
// Turns the font BINARIES anywhere under <staticDir>/ (scanned RECURSIVELY, any
// flat or nested layout — no `fonts/` subfolder required) into ResolvedFont[]
// using the SAME shape resolve.ts produces, so the rest of the pipeline (metrics
// / css / rewrite) is untouched. The download-mode dir (<staticDir>/<HOSTED_DIR>)
// is excluded. Local faces never download — their files already live on disk and
// are served from '/' + their path under static/.
//
// FILENAMES CARRY NO MEANING. Family, weight, style, and variable range are read
// from the font binary via fontkit. The directory layout is the user's free
// choice. (The extension is still used — only to pick the CSS format() token.)
//
// THE originalURL TRICK: each face src carries both
//   url:         '/fonts/<rel, per-seg encodeURIComponent>'  (browser-served path; css.ts emits this)
//   originalURL: file://…/<file>                              (metrics.ts reads this off disk)
// metrics.ts's firstRemoteWoff2Url returns src.originalURL ?? src.url, and
// getMetricsForFamily(<local family>) is null (not in the capsize DB), so
// readMetrics(file://) produces a CLS fallback exactly like a Google font — with
// ZERO changes to metrics.ts or css.ts. css.ts emits src.url (quoted) and
// ignores originalURL. (Honored for woff2 only; woff/ttf/otf get @font-face +
// vars but no size-adjust override — prefer woff2 for CLS reduction.)
// ============================================================================
import { glob, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as fontkit from 'fontkit'; // NAMED namespace, no default
import type { Font, FontCollection } from 'fontkit';
import type { FontFaceData } from 'unifont';
import type { ResolvedFont } from './resolve.js';
import type { FontDisplay, FontCategory } from './options.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A static weight (number) or a variable wght range ([min, max]). */
export type Weight = number | [number, number];

/** What we read from ONE font binary. */
export interface DerivedFace {
  /** f.familyName, trimmed, non-empty. */
  family: string;
  /** number (static usWeightClass) | [min, max] (variable wght axis). */
  weight: Weight;
  style: 'normal' | 'italic' | 'oblique';
  /** true when the wght axis is present (weight is a tuple). */
  variable: boolean;
  /** CSS format() token: 'woff2' | 'woff' | 'truetype' | 'opentype'. */
  format: string;
  /** Browser-served path: '/fonts/<rel, per-seg encodeURIComponent>'. */
  url: string;
  /** file:// URL of the binary on disk, for metrics.ts CLS reading. */
  originalURL: string;
  /** Inferred from the binary: 'mono'/'serif' when detectable, else 'sans'. */
  category: FontCategory;
}

// ---------------------------------------------------------------------------
// Extension -> CSS format() mapping (extension no longer carries weight/style)
// ---------------------------------------------------------------------------

/** Supported font file extensions (without the dot, lowercased). */
type SupportedExt = 'woff2' | 'woff' | 'ttf' | 'otf';

/** Map a (lowercased, dot-less) extension to its CSS `format("…")` string. */
function formatFor(ext: string): string {
  switch (ext) {
    case 'woff2':
      return 'woff2';
    case 'woff':
      return 'woff';
    case 'ttf':
      return 'truetype';
    case 'otf':
      return 'opentype';
    default:
      return ext; // unreachable for glob-matched files; keep total.
  }
}

/** Format preference: best-supported format first in the emitted src list. */
const EXT_ORDER: Record<SupportedExt, number> = { woff2: 0, woff: 1, ttf: 2, otf: 3 };

/** Stable sort key: group by style, then ascending numeric weight. */
const STYLE_ORDER: Record<'normal' | 'italic' | 'oblique', number> = {
  normal: 0,
  italic: 1,
  oblique: 2,
};

/** Smallest weight for ordering: tuple -> its min. */
function numericWeight(w: Weight): number {
  return Array.isArray(w) ? w[0] : w;
}

/** Collapse-key for a weight: tuple -> "min-max", scalar -> "n". */
function weightKey(w: Weight): string {
  return Array.isArray(w) ? `${w[0]}-${w[1]}` : String(w);
}

/** Collapse internal whitespace to single spaces and trim (family normalize). */
function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Binary -> face derivation
// ---------------------------------------------------------------------------

/** A name-table record: language code -> string, e.g. { en: 'Suisse Intl' }. */
type LocalizedName = Record<string, string>;
/** Typographic family/subfamily (name IDs 16/17); @types/fontkit doesn't type these. */
interface TypographicNames {
  preferredFamily?: LocalizedName;
  preferredSubfamily?: LocalizedName;
}

/** Pick the English value (or the first available) from a localized name record. */
function pickName(rec?: LocalizedName): string | undefined {
  if (!rec) return undefined;
  return rec.en ?? Object.values(rec)[0];
}

/**
 * PURE binary->face: given a fontkit Font, the relative path (POSIX-ish, from the
 * fonts/ root) and the absolute path, derive the DerivedFace. The single source
 * of truth for binary->face. Returns null (caller warns) when familyName is empty.
 */
/**
 * Infer the font category from the binary. Monospace is reliable via the `post`
 * table's isFixedPitch (or PANOSE proportion = 9). Serif via the PANOSE serif
 * style. PANOSE is often all-zero (e.g. gstatic woff2), so serif isn't always
 * detectable — override via `local.families`. Never throws.
 */
function inferCategory(font: Font): FontCategory {
  try {
    if ((font as unknown as { post?: { isFixedPitch?: number } }).post?.isFixedPitch) return 'mono';
    const panose = (font['OS/2'] as unknown as { panose?: number[] } | undefined)?.panose;
    if (panose && panose[0] === 2) {
      if (panose[3] === 9) return 'mono'; // bProportion: monospaced
      if (panose[1] >= 2 && panose[1] <= 10) return 'serif'; // bSerifStyle: a serif
    }
  } catch {
    /* missing/undecodable post or OS/2 table -> fall through to 'sans' */
  }
  return 'sans';
}

export function deriveFace(font: Font, rel: string, absPath: string): DerivedFace | null {
  // Prefer the TYPOGRAPHIC family/subfamily (name IDs 16/17) over the legacy
  // RIBBI family (name ID 1). Static weight-split fonts bake the weight into the
  // legacy family ("Suisse Intl Semibold") but set nameID16 "Suisse Intl" +
  // nameID17 "Semibold", so all weights group under one family. The weight still
  // comes from OS/2. @types/fontkit doesn't type the raw name table -> cast.
  const records = (font as unknown as { name?: { records?: TypographicNames } }).name?.records;
  const family = (pickName(records?.preferredFamily) ?? font.familyName ?? '').trim();
  if (!family) return null;

  // variable here means "has a wght axis" (we emit it as a font-weight range).
  // ponytail: wdth/opsz/ital/slnt axes aren't expanded into descriptors — the
  // variable file still loads, just at default for those axes. Upgrade path:
  // emit font-width / a second italic face when wdth / ital|slnt axes exist.
  const wght = font.variationAxes?.wght; // { name, min, default, max } | undefined
  const variable = Boolean(wght);
  // usWeightClass can be 0/absent on subsetted/malformed binaries -> treat as 400.
  const usw = font['OS/2']?.usWeightClass;
  const weight: Weight = wght
    ? [wght.min, wght.max]
    : usw && usw >= 1
      ? Math.min(usw, 1000)
      : 400;

  // font.italicAngle is a GETTER that throws when the `post` table is missing or
  // undecodable (common in subsetted fonts) — guard it.
  let italicAngle = 0;
  try {
    italicAngle = font.italicAngle ?? 0;
  } catch {
    /* no / undecodable post table */
  }
  const sub = pickName(records?.preferredSubfamily) ?? font.subfamilyName ?? '';
  const sel = font['OS/2']?.fsSelection; // OS/2 italic/oblique bits (most reliable)
  const style: 'normal' | 'italic' | 'oblique' =
    sel?.italic || /italic/i.test(sub) || italicAngle !== 0
      ? 'italic'
      : sel?.oblique || /oblique/i.test(sub)
        ? 'oblique'
        : 'normal';

  const format = formatFor(extname(rel).slice(1).toLowerCase()); // woff2|woff|ttf|otf

  // Served path: staticDir is served at '/', and `rel` is relative to staticDir,
  // so the url is '/' + rel (per-segment encoded, Windows '\' normalized). A file
  // at static/fonts/Demo Local/x.woff2 -> '/fonts/Demo%20Local/x.woff2'; one at
  // static/brand/x.woff2 -> '/brand/x.woff2'.
  const url = '/' + rel.split(/[\\/]/).map(encodeURIComponent).join('/');
  const originalURL = pathToFileURL(absPath).href;

  return { family, weight, style, variable, format, url, originalURL, category: inferCategory(font) };
}

/**
 * Read + parse ONE font file into a DerivedFace. Mirrors detect.ts robustness:
 * try/catch around IO and parse, console.error + skip (return null) on any
 * failure — fontkit.create THROWS on garbage and returns a FontCollection
 * (.ttc/.dfont, has `.fonts`) which we don't support.
 */
// Per-file cache keyed by absPath, invalidated on mtime change — so dev hot
// updates (which re-run generate() on every edit) don't re-read+parse every
// binary each time.
const faceCache = new Map<string, { mtimeMs: number; size: number; face: DerivedFace | null }>();

export async function readFontFace(absPath: string, rel: string): Promise<DerivedFace | null> {
  let st: { mtimeMs: number; size: number };
  try {
    st = await stat(absPath);
  } catch {
    return null; // file vanished mid-scan; skip silently.
  }
  // Key on mtime AND size so a same-mtime overwrite (rare but possible) still busts the cache.
  const cached = faceCache.get(absPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.face;

  const face = await readAndDerive(absPath, rel);
  faceCache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, face });
  return face;
}

/** Read + parse + derive ONE file. console.error + null on any failure. */
async function readAndDerive(absPath: string, rel: string): Promise<DerivedFace | null> {
  let buf: Buffer;
  try {
    buf = await readFile(absPath);
  } catch {
    return null;
  }

  let parsed: Font | FontCollection;
  try {
    parsed = fontkit.create(buf);
  } catch (e) {
    console.error(`[vite-plugin-font] skipping local font "${rel}": ${(e as Error).message}`);
    return null;
  }

  if ('fonts' in parsed) {
    console.error(
      `[vite-plugin-font] skipping font collection "${rel}": ` +
        `.ttc/.dfont collections are not supported.`,
    );
    return null;
  }

  // deriveFace reads fontkit getters that can throw on partially-corrupt tables.
  let face: DerivedFace | null;
  try {
    face = deriveFace(parsed, rel, absPath);
  } catch (e) {
    console.error(`[vite-plugin-font] skipping local font "${rel}": ${(e as Error).message}`);
    return null;
  }
  if (!face) {
    console.error(`[vite-plugin-font] skipping local font "${rel}": font binary has no familyName.`);
  }
  return face;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan the WHOLE <staticDir>/ RECURSIVELY for *.woff2|woff|ttf|otf and group the
 * binaries by their READ familyName into ResolvedFont[]. Drop fonts anywhere
 * under static/ — no `fonts/` subfolder required. Within a family, faces sharing
 * the same (weightKey, style) merge their multiple FORMATS into one face (src
 * ordered woff2->woff->ttf->otf; same-format duplicates dropped with a warning).
 * Filenames and directory names carry NO meaning.
 *
 * The download-mode dir (<staticDir>/<HOSTED_DIR>) is excluded so self-hosted CDN
 * fonts are never re-processed as local.
 */
export async function scanLocalFonts(args: {
  /** ABSOLUTE path (plugin.ts passes path.resolve(root, options.staticDir)). */
  staticDir: string;
  /** Stamped onto every face (face.display ??= display), like resolve.ts. */
  display?: FontDisplay;
  /** Top-level dir names under staticDir to skip (plugin passes [HOSTED_DIR]). */
  exclude?: string[];
}): Promise<ResolvedFont[]> {
  const { staticDir, display, exclude = [] } = args;

  // RECURSIVE discovery via node:fs/promises glob (handles ** + braces + spaces).
  const rels: string[] = [];
  try {
    for await (const r of glob('**/*.{woff2,woff,ttf,otf}', { cwd: staticDir })) {
      // Skip excluded top-level dirs — notably download-mode output
      // (static/<HOSTED_DIR>/), which are CDN fonts the plugin already manages.
      if (exclude.includes(r.split(/[\\/]/)[0])) continue;
      rels.push(r);
    }
  } catch {
    return []; // static/ missing or unreadable: nothing to scan.
  }
  rels.sort(); // deterministic discovery order (drives first-seen family casing + dup tiebreak).

  // Read every binary ONCE, carrying each face's source rel through for the
  // duplicate-skip warning. readFontFace already warned + returned null on skip.
  const faceList = await Promise.all(
    rels.map(async (rel) => ({ rel, face: await readFontFace(join(staticDir, rel), rel) })),
  );
  const paired = faceList.filter(
    (x): x is { rel: string; face: DerivedFace } => x.face !== null,
  );

  // Two-level grouping:
  //   familyKey (normalized) -> { family: <first-seen raw>, faces: faceKey -> entries[] }
  // faceKey = `${weightKey}|${style}`. Keep the FIRST-seen RAW familyName so
  // @font-face + per-family var preserve the binary's case/spacing.
  type Entry = { face: DerivedFace; rel: string };
  type FamilyBucket = { family: string; faces: Map<string, Entry[]> };
  const families = new Map<string, FamilyBucket>();

  for (const { rel, face } of paired) {
    const famKey = collapseWs(face.family).toLowerCase();
    let bucket = families.get(famKey);
    if (!bucket) {
      bucket = { family: face.family, faces: new Map() };
      families.set(famKey, bucket);
    }
    const fk = `${weightKey(face.weight)}|${face.style}`;
    let list = bucket.faces.get(fk);
    if (!list) bucket.faces.set(fk, (list = []));
    list.push({ face, rel });
  }

  const out: ResolvedFont[] = [];

  for (const bucket of families.values()) {
    const faces: FontFaceData[] = [];

    for (const [, entries] of bucket.faces) {
      // Best format first; stable rel tiebreak. Drop same-format duplicates.
      entries.sort(
        (a, b) =>
          (EXT_ORDER[ext(a.rel)] ?? 99) - (EXT_ORDER[ext(b.rel)] ?? 99) ||
          a.rel.localeCompare(b.rel),
      );

      const seenFormat = new Set<string>();
      const src: FontFaceData['src'] = [];
      for (const { face, rel } of entries) {
        if (seenFormat.has(face.format)) {
          console.error(
            `[vite-plugin-font] skipping duplicate local font "${rel}": ` +
              `same family/weight/style/format as another file.`,
          );
          continue;
        }
        seenFormat.add(face.format);
        src.push({ url: face.url, format: face.format, originalURL: face.originalURL });
      }

      // weight + style are identical across the group (same faceKey).
      const { weight, style } = entries[0].face;
      faces.push({ src, weight, style, ...(display ? { display } : {}) });
    }

    if (faces.length === 0) continue;

    // Deterministic face order: style group, ascending numeric weight, then faceKey.
    faces.sort((a, b) => {
      const sa = STYLE_ORDER[(a.style ?? 'normal') as 'normal' | 'italic' | 'oblique'];
      const sb = STYLE_ORDER[(b.style ?? 'normal') as 'normal' | 'italic' | 'oblique'];
      if (sa !== sb) return sa - sb;
      const wa = numericWeight(a.weight as Weight);
      const wb = numericWeight(b.weight as Weight);
      if (wa !== wb) return wa - wb;
      const ka = `${weightKey(a.weight as Weight)}|${a.style ?? 'normal'}`;
      const kb = `${weightKey(b.weight as Weight)}|${b.style ?? 'normal'}`;
      return ka.localeCompare(kb);
    });

    const variable = faces.some((f) => Array.isArray(f.weight));

    // Family category from the binaries: mono/serif win over sans, so a
    // self-hosted IBM Plex Mono gets a monospace fallback (not the sans default).
    // plugin.ts still applies any per-family override from options.local.families.
    const cats = new Set<FontCategory>();
    for (const [, entries] of bucket.faces) for (const e of entries) cats.add(e.face.category);
    const category: FontCategory = cats.has('mono') ? 'mono' : cats.has('serif') ? 'serif' : 'sans';
    out.push({ family: bucket.family, faces, category, variable });
  }

  // Stable CSS output: sort families by name.
  out.sort((a, b) => a.family.localeCompare(b.family));
  return out;
}

/** Dot-less, lowercased extension of a relative path. */
function ext(rel: string): SupportedExt {
  return extname(rel).slice(1).toLowerCase() as SupportedExt;
}

// ---------------------------------------------------------------------------
// Tiny runnable self-check: `node src/lib/local.ts` (Node 24 runs .ts).
// Binary-only has no pure filename parser, so this reads the COMMITTED demo
// binary and asserts the DERIVATION. fs-touching by design; the path is relative
// to import.meta.dirname so running from the repo root works. Skips cleanly if no
// demo font is present.
//
// CAVEAT (the whole point of dropping filename conventions): the demo file is
// NAMED variable.woff2 but is BINARILY a static 400 face — we assert the BINARY
// truth (400 / static), NOT the filename's "variable".
// ---------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { strict: assert } = await import('node:assert');
  // rel is now relative to staticDir (the whole static/ is scanned), so it
  // includes the fonts/ segment and the url is '/' + rel.
  const demoRel = 'fonts/Demo Local/variable.woff2';
  const demoAbs = join(import.meta.dirname, '../../static', demoRel);

  let failures = 0;
  const check = (label: string, fn: () => void) => {
    try {
      fn();
      console.log(`ok   ${label}`);
    } catch (e) {
      failures++;
      console.error(`FAIL ${label}: ${(e as Error).message}`);
    }
  };

  // Skip cleanly when the demo binary is absent.
  let demoPresent = true;
  try {
    await readFile(demoAbs);
  } catch {
    demoPresent = false;
  }

  if (!demoPresent) {
    console.log(`skip — no demo font at ${demoRel}; nothing to self-check.`);
  } else {
    const face = await readFontFace(demoAbs, demoRel);

    check('readFontFace returns a face', () => assert.notEqual(face, null));
    if (face) {
      check('family is the BINARY familyName', () =>
        assert.equal(face.family, 'Recursive Sans Linear Light'),
      );
      check('weight is static 400 (usWeightClass, not a variable range)', () =>
        assert.equal(face.weight, 400),
      );
      check('variable is false (variationAxes has no wght)', () =>
        assert.equal(face.variable, false),
      );
      check('style is normal (subfamily Regular, italicAngle 0)', () =>
        assert.equal(face.style, 'normal'),
      );
      check('format is woff2', () => assert.equal(face.format, 'woff2'));
      check('url is per-segment encoded', () =>
        assert.equal(face.url, '/fonts/Demo%20Local/variable.woff2'),
      );
      check('originalURL is the file:// path', () =>
        assert.ok(face.originalURL.endsWith('/static/fonts/Demo%20Local/variable.woff2')),
      );
    }

    // Find the demo family among results (tolerate other fonts dropped under
    // static/ — the scanner groups by binary family, not file count). Pass the
    // same exclude the plugin uses so download-mode fonts in static/hosted_fonts/
    // are skipped (mirrors production).
    const fonts = await scanLocalFonts({
      staticDir: join(import.meta.dirname, '../../static'),
      exclude: ['hosted_fonts'],
    });
    const rf = fonts.find((f) => f.family === 'Recursive Sans Linear Light');
    check('scanLocalFonts includes the Recursive demo family', () => assert.ok(rf));
    check('hosted_fonts/ (downloaded CDN fonts) are excluded from local scan', () =>
      assert.ok(!fonts.some((f) => f.family === 'Inter')),
    );
    if (rf) {
      check('demo family has a face', () => assert.ok(rf.faces.length >= 1));
      check('demo family not variable', () => assert.equal(rf.variable, false));
      check("demo (Recursive Sans) category inferred 'sans'", () => assert.equal(rf.category, 'sans'));
    }
  }

  if (failures) {
    console.error(`\n${failures} self-check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll self-checks passed.`);
}
