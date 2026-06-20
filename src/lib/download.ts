// ============================================================================
// src/lib/download.ts — SELF-HOSTING
// When source==='download', download every remote woff2 src into
// <staticDir>/hosted_fonts and rewrite the src url to /hosted_fonts/<file>.woff2.
// When source==='cdn', return faces unchanged (keep gstatic urls). Idempotent.
//
// NOTE: a dedicated dir (hosted_fonts, NOT fonts) so downloaded CDN fonts never
// collide with the local-font feature, which owns <staticDir>/fonts/<Family>/.
// ============================================================================
import { writeFile, mkdir, access, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { FontFaceData, RemoteFontSource } from 'unifont';
import type { FontSource } from './options.js';

/** Subdirectory of staticDir for downloaded CDN fonts. Excluded by the local
 *  scanner (local.ts) so self-hosted CDN fonts aren't re-processed as local. */
export const HOSTED_DIR = 'hosted_fonts';

/** Fetch a font binary with a per-request timeout and a small bounded retry. */
async function fetchFont(url: string): Promise<Buffer> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
			if (!res.ok) throw new Error(`status ${res.status}`);
			return Buffer.from(await res.arrayBuffer());
		} catch (err) {
			lastErr = err;
			if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 300));
		}
	}
	throw new Error(`Font download failed for ${url}: ${String(lastErr)}`);
}

/** Lowercase, spaces->'-', strip anything outside [a-z0-9-]. */
function sanitize(input: string): string {
	return input
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

/** Render a font-weight value into a filename-safe token. */
function weightToken(weight: FontFaceData['weight']): string {
	if (Array.isArray(weight)) return `${weight[0]}-${weight[1]}`;
	if (weight === undefined || weight === '') return 'normal';
	return String(weight);
}

/** True for a remote source ({url}) whose url/format indicates woff2. */
function isWoff2Remote(src: RemoteFontSource | { name: string }): src is RemoteFontSource {
	if (!('url' in src) || typeof src.url !== 'string') return false;
	const fmt = (src.format ?? '').toLowerCase();
	return fmt.includes('woff2') || src.url.toLowerCase().includes('.woff2');
}

/**
 * Download remote woff2 sources to <staticDir>/fonts and rewrite their urls.
 * CDN mode is a no-op (faces returned unchanged). Returns a NEW faces array
 * with deep-copied src arrays in download mode — never mutates unifont-cached
 * objects.
 */
export async function materializeFaces(args: {
	faces: FontFaceData[];
	source: FontSource;
	staticDir?: string;
}): Promise<FontFaceData[]> {
	const { faces, source } = args;
	if (source === 'cdn') return faces;

	const staticDir = args.staticDir ?? 'static';
	const hostedDir = join(staticDir, HOSTED_DIR);
	await mkdir(hostedDir, { recursive: true });

	const out: FontFaceData[] = [];
	for (const face of faces) {
		const style = face.style ?? 'normal';
		const weight = weightToken(face.weight);

		const newSrc = await Promise.all(
			face.src.map(async (src) => {
				if (!isWoff2Remote(src)) return src; // local() or non-woff2 pass through

				// Basename keeps the source file unique across faces sharing a weight/style
				// (e.g. unicode-range subsets); url basename is stable + collision-free.
				const base = sanitize(src.url.split('/').pop()?.replace(/\.woff2$/i, '') ?? 'font');
				const filename = `${sanitize(`${weight}-${style}`)}-${base}.woff2`;
				const dest = join(hostedDir, filename);

				// Idempotent: skip the network if the file already exists.
				try {
					await access(dest);
				} catch {
					// Write to a temp file then rename — rename is atomic on the same
					// filesystem, so an interrupted run can never leave a truncated
					// .woff2 that access() would treat as "already downloaded" forever.
					const buf = await fetchFont(src.url);
					const tmp = `${dest}.tmp-${process.pid}`;
					await writeFile(tmp, buf);
					await rename(tmp, dest);
				}

				return { url: `/${HOSTED_DIR}/${filename}`, format: 'woff2', originalURL: src.url };
			})
		);

		out.push({ ...face, src: newSrc });
	}
	return out;
}

// ponytail: filename derives from the url basename (unique per gstatic file)
// rather than the contract's "family-weight-style" — FontFaceData carries no
// family and materializeFaces isn't passed one. CEILING: filenames are less
// human-readable than "inter-400-normal.woff2"; thread a family through the
// args if pretty names matter.

// --- smallest runnable check (node scripts/.. style; run manually) -----------
// Verifies cdn passthrough + sanitize/weight tokens without hitting the network.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const assert = (c: unknown, m: string) => {
		if (!c) throw new Error('FAIL: ' + m);
	};
	const sample: FontFaceData[] = [
		{ src: [{ name: 'Inter' }, { url: 'https://x/y.woff2', format: 'woff2' }], weight: 400 }
	];
	(async () => {
		const same = await materializeFaces({ faces: sample, source: 'cdn' });
		assert(same === sample, 'cdn returns the same array reference');
		assert(sanitize('Open Sans') === 'open-sans', 'sanitize spaces');
		assert(sanitize('Roboto/300!') === 'roboto300', 'sanitize strips junk');
		assert(weightToken([100, 900]) === '100-900', 'variable weight range');
		assert(weightToken(undefined) === 'normal', 'missing weight -> normal');
		console.log('download.ts checks OK');
	})();
}
