// ============================================================================
// src/lib/plugin.ts — Vite plugin (vite-plugin-font)
// Orchestrates the whole pipeline and serves a single virtual:font.css module.
//
//   generate() = normalizeOptions -> [detectFonts] -> resolveFonts
//              -> materializeFaces -> buildFallback (per font) -> buildFontCss
//
// The CSS is generated in buildStart (dev + build) and re-generated on dev
// source changes via handleHotUpdate (then the virtual module is invalidated
// and a css-update is pushed over the websocket).
// ============================================================================
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
	normalizeOptions,
	normalizeFont,
	type FontPluginOptions,
	type FamilyName,
} from './options.js';
import { resolveFonts, type ResolvedFont } from './resolve.js';
import { buildFallback, type FallbackResult } from './metrics.js';
import { materializeFaces, HOSTED_DIR } from './download.js';
import { detectFonts, eqFamily } from './detect.js';
import { detectTailwind, perFamilyVar } from './tailwind.js';
import { buildFontCss } from './css.js';
import { famKey, rewriteFontFamily } from './rewrite.js';
import { scanLocalFonts } from './local.js';
import {
	GOOGLE_FONT_NAMES,
	type GoogleFontName,
} from './generated/google-fonts.js';

const VIRTUAL_ID = 'virtual:font.css';
const RESOLVED_ID = '\0' + VIRTUAL_ID; // NUL prefix marks it internal/virtual
// Component-local const holding the inlined <style> markup (inline mode).
const STYLE_VAR = '__svelte_plugin_font_inline';

/** Insert `stmt` right after the first <script ...> in svelte source (or wrap one). */
function injectIntoScript(code: string, stmt: string): string {
	const open = code.match(/<script[^>]*>/);
	if (open && open.index !== undefined) {
		const at = open.index + open[0].length;
		return code.slice(0, at) + stmt + code.slice(at);
	}
	return `<script>${stmt}</script>\n` + code;
}

// The plugin's own directory. Auto-detect skips it so the plugin's example
// comments and the generated registry never count as "used" fonts. In a real
// install the plugin lives in node_modules (already excluded); this covers the
// case where it lives under the app's src/ (as in this repo).
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');

/** woff2 preload hrefs for a font, preferring the latin subset (avoid preloading every subset). */
function woff2Hrefs(font: ResolvedFont): string[] {
	const faces: { url: string; subset?: string }[] = [];
	for (const face of font.faces) {
		for (const s of face.src) {
			if (!('url' in s)) continue;
			if ((s.format ?? '').includes('woff2') || s.url.includes('.woff2')) {
				faces.push({ url: s.url, subset: face.meta?.subset });
			}
		}
	}
	const latin = faces.filter((f) => f.subset === 'latin');
	return [...new Set((latin.length ? latin : faces).map((f) => f.url))];
}

/** A <link rel="preload" as="font"> tag for a woff2 href (fonts always fetch in CORS mode). */
const preloadTag = (href: string) =>
	`<link rel="preload" as="font" type="font/woff2" href="${href}" crossorigin="anonymous" />`;

export default function fontPlugin(userOptions: FontPluginOptions = {}): Plugin[] {
	const options = normalizeOptions(userOptions);

	let config: ResolvedConfig;
	let server: ViteDevServer | undefined;
	let css = '';
	// famKey(family) -> per-family var name (--font-<family>). The post-CSS pass
	// uses it to rewrite every `font-family` usage to the var.
	let rewriteMap = new Map<string, string>();
	// <link rel="preload"> tags for fonts marked preload:true, injected into <head>.
	let preloadLinks: string[] = [];
	// Cached local-font scan (post-override). null = needs (re)scan. Invalidated by
	// handleHotUpdate only when a font file changes, so source edits don't re-walk static/.
	let cachedLocal: ResolvedFont[] | null = null;

	/** Full pipeline -> the single emitted stylesheet string. */
	async function generate(): Promise<string> {
		const root = config.root;
		const staticDir = path.resolve(root, options.staticDir);

		// 0. Scan LOCAL self-hosted fonts: the WHOLE <staticDir>/ recursively
		//    (excluding hosted_fonts + the user's `local.exclude` dirs), family read
		//    from each binary. Result is CACHED — invalidated by handleHotUpdate only
		//    when a font file changes — so source edits don't re-walk static/. Locals
		//    bypass unifont + materializeFaces; downstream treats them like Google
		//    fonts via the shared ResolvedFont shape.
		if (options.local !== false && cachedLocal === null) {
			const { families, exclude } = options.local;
			const scanned = await scanLocalFonts({
				staticDir,
				display: options.display,
				exclude: [HOSTED_DIR, ...exclude],
			});
			// Apply per-family overrides (category + cssVariable), matched
			// whitespace/case-insensitively so a key like "My Serif" hits binary family "my serif".
			for (const lf of scanned) {
				const key = Object.keys(families).find((k) => eqFamily(k, lf.family));
				const ov = key ? families[key] : undefined;
				if (ov?.category) lf.category = ov.category;
				if (ov?.cssVariable) lf.cssVariable = ov.cssVariable;
			}
			cachedLocal = scanned;
		}
		const localResolved = options.local === false ? [] : (cachedLocal ?? []);
		// Dedup by per-family VAR (--font-<kebab>) so a local "PT Sans" and a Google
		// "PT-Sans" — which both produce --font-pt-sans — collapse to the local one.
		const localVars = new Set(localResolved.map((l) => perFamilyVar(l.family)));
		// Lowercased names feed detectFonts so a `font-family: Cal Sans` usage is
		// recognized, and keep detected local names from being added as Google fonts.
		const localKeys = new Set(localResolved.map((l) => l.family.toLowerCase()));
		const localNames = localResolved.map((l) => l.family);

		// 1. Auto-detect: UNION any registry font used in source into the declared
		//    set (declared entries keep their overrides; detected-only fonts are
		//    added with defaults). Never drops declared fonts. Local families are in
		//    the registry passed to detectFonts so their usages count, but they are
		//    NEVER added to the Google `fonts` list (they come from localResolved and
		//    are always emitted regardless of usage).
		let fonts = options.fonts;
		if (options.autoDetect) {
			const used = await detectFonts({
				root,
				registryNames: [...localNames, ...GOOGLE_FONT_NAMES],
				ignore: [SELF_DIR],
			});
			const extra = used
				.filter((u) => !localKeys.has(u.toLowerCase())) // local handled separately
				.filter((u) => !fonts.some((f) => eqFamily(f.family, u)))
				.map((u) => normalizeFont(u as GoogleFontName));
			if (extra.length) fonts = [...fonts, ...extra];
		}

		// Dedupe: drop any declared/detected Google font whose per-family var collides
		// with a local dir, so the self-hosted copy wins (no duplicate @font-face / var).
		fonts = fonts.filter((f) => !localVars.has(perFamilyVar(f.family)));

		// 2. Tailwind v4 var injection? (true | false | 'auto' deps sniff)
		const tailwindEnabled = detectTailwind({ tailwind: options.tailwind, root });

		// 3. Resolve every font via unifont (-> @font-face data + src urls).
		const resolved = await resolveFonts({
			fonts,
			provider: options.provider,
			display: options.display,
		});

		// 4. Per font: build the CLS fallback FIRST from the original remote (gstatic)
		//    faces — readMetrics needs a fetchable URL, and download mode rewrites
		//    urls to protocol-less /fonts/* paths. THEN self-host for emission.
		const fallbacks = new Map<FamilyName, FallbackResult>();
		const finalResolved: ResolvedFont[] = [];
		for (const r of resolved) {
			fallbacks.set(
				r.family,
				await buildFallback({ family: r.family, faces: r.faces, category: r.category }),
			);
			const faces = await materializeFaces({
				faces: r.faces,
				source: options.source,
				staticDir,
			});
			finalResolved.push({ ...r, faces });
		}

		// 4b. LOCAL fonts: build the CLS fallback (metrics.ts reads the file:// URL
		//     carried in each face's originalURL) but DO NOT materialize — the files
		//     already live on disk and the faces already point at /fonts/<rel path>.
		//     Appended AFTER Google so a self-hosted family wins the shared category
		//     var (--font-sans/serif/mono); per-family vars never collide.
		for (const r of localResolved) {
			fallbacks.set(
				r.family,
				await buildFallback({ family: r.family, faces: r.faces, category: r.category }),
			);
			finalResolved.push(r);
		}

		// Collect preload <link> hrefs for fonts marked preload:true. Matched by
		// family key so a declared local family (deduped out of `fonts`) still
		// preloads. woff2 only (the <link type> is font/woff2).
		const preloadKeys = new Set(
			options.fonts.filter((f) => f.preload).map((f) => famKey(f.family)),
		);
		preloadLinks = preloadKeys.size
			? [
					...new Set(
						finalResolved
							.filter((r) => preloadKeys.has(famKey(r.family)))
							.flatMap(woff2Hrefs),
					),
				].map(preloadTag)
			: [];

		// Build the usage-rewrite map: every resolved font -> its per-family var
		// (--font-<family>), which css.ts always emits in :root and which holds the
		// web font + metric fallback + generics. Local families are in finalResolved
		// too, so `font-family: Cal Sans` usages rewrite to var(--font-cal-sans).
		rewriteMap = new Map();
		for (const r of finalResolved) {
			rewriteMap.set(famKey(r.family), perFamilyVar(r.family));
		}

		// 5. Assemble the final stylesheet.
		return buildFontCss({
			resolved: finalResolved,
			fallbacks,
			tailwindEnabled,
			options,
		});
	}

	// DEBUG dump path + writer. Written ONLY when the CSS changes (not on every
	// generate) and IGNORED by handleHotUpdate — otherwise the write would
	// retrigger HMR and loop forever.
	const DEBUG_CSS = 'svelte-plugin-font.debug.css';
	async function maybeWriteDebug(stylesheet: string): Promise<void> {
		if (!options.debug) return;
		const debugPath = path.resolve(config.root, DEBUG_CSS);
		await writeFile(debugPath, stylesheet, 'utf8');
		console.log(`[vite-plugin-font] wrote generated CSS -> ${debugPath} (${stylesheet.length} bytes)`);
	}

	// MAIN plugin (enforce: 'pre'): pipeline, virtual module, root injection, HMR.
	const main: Plugin = {
		name: 'vite-plugin-font',
		enforce: 'pre',

		// Capture the resolved config (root for detect/static/tailwind).
		configResolved(resolved) {
			config = resolved;
		},

		// Build the stylesheet once at startup (dev AND build).
		async buildStart() {
			css = await generate();
			await maybeWriteDebug(css);
		},

		// MAGIC: into SvelteKit's synthetic root component
		// (.svelte-kit/generated/root.svelte — ALWAYS present, with or without a
		// user +layout.svelte) inject (a) the `import 'virtual:font.css'` so the CSS
		// lands in %sveltekit.head% on every route, and (b) a <svelte:head> with the
		// <link rel="preload"> tags for fonts marked preload:true. Runs in the 'pre'
		// phase, before vite-plugin-svelte compiles it.
		transform(code, id) {
			if (!id.replace(/\\/g, '/').endsWith('/generated/root.svelte')) return undefined;
			let out = code;
			const headParts: string[] = [];

			// `inject` gates ALL auto-injection (inject:false => user wires it up
			// themselves). When injecting, `inline` (default) bakes the stylesheet
			// straight into the SSR <head>; otherwise we import the virtual module
			// and let SvelteKit emit a linked/collected stylesheet.
			if (options.inject) {
				if (options.inline) {
					// INLINE: the @font-face + :root vars are present at first paint — no
					// separate stylesheet to load late (slow-network CLS fix). The /fonts
					// + gstatic urls are absolute, so they resolve as-is.
					const tag = `<style data-svelte-plugin-font>${css}</style>`;
					out = injectIntoScript(out, `\n\tconst ${STYLE_VAR} = ${JSON.stringify(tag)};`);
					headParts.push(`{@html ${STYLE_VAR}}`);
				} else if (!/import\s+['"]virtual:font\.css['"]/.test(out)) {
					// LINK: import the virtual module so SvelteKit emits it into the head.
					out = injectIntoScript(out, `\n\timport '${VIRTUAL_ID}';`);
				}
			}

			// (b) preload <link>s for fonts marked preload:true.
			if (preloadLinks.length) headParts.push(...preloadLinks);

			// One <svelte:head> for everything (Svelte merges, but keep it single).
			if (headParts.length) out += `\n<svelte:head>\n${headParts.join('\n')}\n</svelte:head>\n`;

			return out === code ? undefined : out;
		},

		// Claim + serve virtual:font.css.
		resolveId(id) {
			if (id === VIRTUAL_ID) return RESOLVED_ID;
			return undefined;
		},
		load(id) {
			if (id === RESOLVED_ID) return css;
			return undefined;
		},

		// Keep a server handle for HMR invalidation.
		configureServer(s) {
			server = s;
		},

		// A source edit may change which fonts are referenced (autoDetect) or the
		// emitted CSS. Regenerate; only force the virtual module to update when the
		// CSS actually changed, and let Vite drive HMR for everything (including
		// the edited file).
		async handleHotUpdate(ctx) {
			const f = ctx.file;
			// IGNORE our own debug dump — writing it triggers a .css change, which would
			// re-enter here and loop forever.
			if (f.replace(/\\/g, '/').endsWith('/' + DEBUG_CSS)) return undefined;
			// Also react to local font files dropped anywhere under static/ (recursive;
			// family read from the binary) during dev, so a newly-added/changed face is
			// picked up without a server restart.
			if (
				!/\.(svelte|css|pcss|scss|ts|js|woff2|woff|ttf|otf)$/.test(f) ||
				f.includes('node_modules')
			) {
				return undefined;
			}
			// Invalidate the local-scan cache ONLY when a font file changed — source
			// edits reuse the cache (no static/ re-walk).
			if (/\.(woff2|woff|ttf|otf)$/.test(f)) cachedLocal = null;
			const next = await generate();
			if (next === css) return undefined; // nothing font-related changed
			css = next;
			await maybeWriteDebug(css); // only on real change; the file is ignored above
			const targetServer = ctx.server ?? server;
			if (!targetServer) return undefined;
			const updated = [...ctx.modules];

			if (options.inline) {
				// Inline mode: the <style> is baked into the generated root component,
				// so re-transform it (the virtual module isn't imported).
				const rootFile = path.resolve(config.root, '.svelte-kit/generated/root.svelte');
				for (const m of targetServer.moduleGraph.getModulesByFile(rootFile) ?? []) {
					targetServer.moduleGraph.invalidateModule(m);
					updated.push(m);
				}
			} else {
				// Linked mode: invalidate the virtual module so its <style> hot-updates.
				const mod = targetServer.moduleGraph.getModuleById(RESOLVED_ID);
				if (mod) {
					targetServer.moduleGraph.invalidateModule(mod);
					updated.push(mod);
				}
			}
			return updated;
		},
	};

	const isCssId = (norm: string) =>
		(/\.(css|pcss|scss|less)(\?|$)/.test(norm) || /[?&](type=style|lang\.css)/.test(norm)) &&
		!norm.includes('/node_modules/') &&
		!norm.startsWith(SELF_DIR) &&
		!norm.includes('virtual:font');

	// REWRITE plugin (NO enforce = "normal"): runs AFTER Tailwind's enforce:'pre'
	// transform (so it sees the generated `font-[…]` utilities) but BEFORE Vite's
	// css-post wraps the stylesheet into a JS module. So it rewrites RAW css —
	// component <style>, app.css, and Tailwind utilities — in BOTH dev and build.
	// (At enforce:'post' it would instead receive `export default "…css…"` and the
	// css, now a JS string literal, would be skipped.) @font-face, comments,
	// strings, our virtual module, node_modules and the plugin's own dir are left
	// untouched by rewriteFontFamily.
	const rewriteCss: Plugin = {
		name: 'vite-plugin-font:rewrite',
		transform(code, id) {
			if (!options.rewrite || rewriteMap.size === 0) return undefined;
			if (!isCssId(id.replace(/\\/g, '/'))) return undefined;
			const out = rewriteFontFamily(code, rewriteMap);
			return out === code ? undefined : out;
		},
	};

	// BUILD safety net (enforce:'post'): generateBundle runs after Vite has emitted
	// the final CSS assets, so it covers any stylesheet the transform pass didn't
	// flow through. Idempotent (already-rewritten var() tokens don't re-match).
	// ponytail: rewrites minified asset text, not the .map.
	const rewriteBundle: Plugin = {
		name: 'vite-plugin-font:rewrite-bundle',
		enforce: 'post',
		generateBundle(_outputOptions, bundle) {
			if (!options.rewrite || rewriteMap.size === 0) return;
			for (const file of Object.keys(bundle)) {
				const asset = bundle[file];
				if (asset.type === 'asset' && file.endsWith('.css') && typeof asset.source === 'string') {
					asset.source = rewriteFontFamily(asset.source, rewriteMap);
				}
			}
		},
	};

	return [main, rewriteCss, rewriteBundle];
}
