// ============================================================================
// src/lib/font-module.ts — source of the `virtual:font` runtime module.
// Emitted as a plain-JS string: a virtual module is always processed by Vite,
// whereas a package import could be externalized in SSR and then couldn't load
// the build-time font data. Exposes the resolved fonts and `fontHandle`, a
// SvelteKit handle that applies + preloads a font chosen per request.
// ============================================================================

/** family -> its per-family CSS var + the woff2 urls worth preloading. */
export type FontManifest = Record<string, { variable: string; preload: string[] }>;

/** Source of `virtual:font` for the given manifest. */
export function fontModule(manifest: FontManifest): string {
	// Null prototype: `fonts[userInput]` can never hit Object.prototype
	// ("constructor", "__proto__", …) — unknown keys are simply undefined.
	return (
		`export const fonts = Object.freeze(Object.assign(Object.create(null), ${JSON.stringify(manifest)}));\n` +
		RUNTIME
	);
}

const RUNTIME = String.raw`
const preloadLink = (href) => '<' + href + '>; rel=preload; as=font; type="font/woff2"; crossorigin';

// Picker result -> [{ variable, font }]. A string is shorthand for { sans }.
// Each key maps to --font-<key> (sans/serif/mono = Tailwind's vars; any other
// name works too), or is used as-is when it's already a --custom-var.
function choices(picked) {
	const slots =
		typeof picked === 'string' ? { sans: picked }
		: picked && typeof picked === 'object' && !Array.isArray(picked) ? picked
		: {};
	const out = [];
	for (const [slot, family] of Object.entries(slots)) {
		const variable = slot.startsWith('--') ? slot : '--font-' + slot;
		// The var lands inside an HTML attribute: plain custom-property names only.
		if (!/^--[\w-]+$/.test(variable)) {
			console.error('[svelte-plugin-font] fontHandle: ignoring invalid key "' + slot + '"');
			continue;
		}
		const font = typeof family === 'string' ? fonts[family] : undefined;
		if (font) out.push({ variable, font });
	}
	return out;
}

export function fontHandle(pick) {
	return async ({ event, resolve }) => {
		// Resolved lazily and once: only HTML page renders need it (not endpoints
		// or __data.json), and by then load functions have run.
		let chosen;
		const get = () =>
			(chosen ??= Promise.resolve()
				.then(() => pick(event))
				.then(choices)
				.catch((err) => {
					// A font preference must never break the page.
					console.error('[svelte-plugin-font] fontHandle: font picker failed', err);
					return [];
				}));
		let page = false;
		let styled = false;
		const response = await resolve(event, {
			async transformPageChunk({ html }) {
				page = true;
				if (styled) return html; // <html> lives in the first chunk
				styled = true;
				const picks = await get();
				if (!picks.length) return html;
				const decl = picks.map((p) => p.variable + ': var(' + p.font.variable + ')').join('; ');
				// Inline style on <html>: beats the plugin's :root vars whatever the order.
				return html.replace(/<html\b[^>]*>/i, (tag) => {
					const m = /\sstyle\s*=\s*["']/i.exec(tag);
					if (!m) return '<html style="' + decl + '"' + tag.slice(5);
					const at = m.index + m[0].length;
					return tag.slice(0, at) + decl + '; ' + tag.slice(at);
				});
			},
		});
		const picks = page ? await get() : [];
		// Link header: the downloads start before the HTML is even parsed. Deduped, so
		// one font picked for two slots is preloaded once.
		for (const href of new Set(picks.flatMap((p) => p.font.preload))) {
			response.headers.append('Link', preloadLink(href));
		}
		return response;
	};
}
`;
