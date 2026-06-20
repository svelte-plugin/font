// ============================================================================
// src/lib/rewrite.ts — rewrite `font-family` usages to a per-font CSS variable
// Turns `font-family: Inter, sans-serif` into `font-family: var(--font-inter),
// sans-serif`, where `--font-inter` (defined once in :root by the plugin) holds
// the web font + metric fallback + generics. So Tailwind `font-[…]` utilities and
// raw declarations alike get CLS reduction, with one shared definition.
//
// This is a small string/comment/brace-aware scanner rather than a bare regex:
// it must not corrupt arbitrary user/Tailwind CSS. It skips string literals,
// comments, CSS escapes (e.g. Tailwind's `.font-\[\'X\'\]` selectors), and
// `@font-face` blocks (a var() there is invalid), and preserves `!important`.
// Handles BOTH the `font-family` longhand and the `font` shorthand (the family
// is the trailing part after `font-size[/line-height]`). Ceiling: shorthands with
// no recognizable font-size (e.g. system keywords `font: menu`) are left as-is.
// ============================================================================

/** Normalize a font token (unquote + collapse whitespace + lowercase) for matching. */
export const famKey = (s: string): string =>
	s.trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ').toLowerCase();

// The `font` shorthand is `[style|variant|weight|stretch]* <size>[/<line-height>]
// <family-list>`. Split off the family-list: everything after the first font-size
// token (a <length>/<percentage> or size keyword) and optional `/line-height`.
const SHORTHAND_RE =
	/^(.*?\b(?:[\d.]+(?:px|r?em|%|pt|pc|q|ch|ex|cap|ic|lh|rlh|vh|vw|vi|vb|vmin|vmax|cm|mm|in)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:\s*\/\s*\S+)?\s+)(.+)$/i;

/**
 * Split a `font` shorthand value into `{ head, family }`, where `head` is
 * everything up to and including the size/line-height (with trailing space) and
 * `family` is the font-family list. Returns null when no font-size is found
 * (system keywords like `menu`, `caption`, or `inherit`).
 */
export function splitFontShorthand(value: string): { head: string; family: string } | null {
	const m = SHORTHAND_RE.exec(value);
	return m ? { head: m[1], family: m[2] } : null;
}

/** Rewrite one `font-family` value (the text after the colon). null = no change. */
function rewriteValue(rawValue: string, map: Map<string, string>): string | null {
	// Peel a trailing !important so it survives the rewrite.
	const imp = /\s*!important\s*$/i.exec(rawValue);
	const important = imp ? rawValue.slice(imp.index) : '';
	const value = imp ? rawValue.slice(0, imp.index) : rawValue;

	const parts = value.split(',');
	for (let k = 0; k < parts.length; k++) {
		const varName = map.get(famKey(parts[k]));
		if (!varName) continue;
		const lead = parts[k].match(/^\s*/)?.[0] ?? '';
		const trail = parts[k].match(/\s*$/)?.[0] ?? '';
		parts[k] = `${lead}var(${varName})${trail}`;
		return parts.join(',') + important;
	}
	return null;
}

export function rewriteFontFamily(code: string, map: Map<string, string>): string {
	if (!map.size) return code;
	const n = code.length;
	let out = '';
	let i = 0;
	let prelude = ''; // selector/at-rule text since the last { } or ;
	let lastSig = ''; // last non-whitespace char emitted (for declaration-start detection)
	const ffStack: boolean[] = []; // is each currently-open block an @font-face?

	const emit = (s: string) => {
		out += s;
		const t = s.replace(/\s+$/, '');
		if (t) lastSig = t[t.length - 1];
	};

	while (i < n) {
		const c = code[i];

		// CSS escape (e.g. `\[`, `\'` in Tailwind arbitrary-value selectors) — consume the pair.
		if (c === '\\' && i + 1 < n) {
			emit(code.slice(i, i + 2));
			prelude += code.slice(i, i + 2);
			i += 2;
			continue;
		}
		// Comment.
		if (c === '/' && code[i + 1] === '*') {
			const end = code.indexOf('*/', i + 2);
			const stop = end === -1 ? n : end + 2;
			emit(code.slice(i, stop));
			prelude += code.slice(i, stop);
			i = stop;
			continue;
		}
		// String literal (consume whole; its braces/semicolons/quotes are inert).
		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < n) {
				if (code[j] === '\\') { j += 2; continue; }
				if (code[j] === c) { j++; break; }
				j++;
			}
			emit(code.slice(i, j));
			prelude += code.slice(i, j);
			i = j;
			continue;
		}
		if (c === '{') { ffStack.push(/@font-face/i.test(prelude)); prelude = ''; emit(c); i++; continue; }
		if (c === '}') { ffStack.pop(); prelude = ''; emit(c); i++; continue; }
		if (c === ';') { prelude = ''; emit(c); i++; continue; }

		// A `font-family`/`font` declaration starts only right after `{`, `;`, or file start.
		const atDeclStart = lastSig === '{' || lastSig === ';' || lastSig === '';
		const inFontFace = ffStack.length > 0 && ffStack[ffStack.length - 1];
		if ((c === 'f' || c === 'F') && atDeclStart && !inFontFace) {
			const rest = code.slice(i);

			// `font-family: <value>` — rewrite the whole value.
			const mff = /^font-family\s*:\s*([^;{}]*)/i.exec(rest);
			if (mff) {
				const value = mff[1];
				const rewritten = rewriteValue(value, map);
				emit(mff[0].slice(0, mff[0].length - value.length) + (rewritten ?? value));
				i += mff[0].length;
				continue;
			}

			// `font: … <family>` shorthand — rewrite only the trailing family list.
			const mfs = /^font\s*:\s*([^;{}]*)/i.exec(rest);
			if (mfs) {
				const value = mfs[1];
				const split = splitFontShorthand(value);
				const rewrittenFamily = split && rewriteValue(split.family, map);
				if (split && rewrittenFamily !== null && rewrittenFamily !== undefined) {
					emit(mfs[0].slice(0, mfs[0].length - value.length) + split.head + rewrittenFamily);
					i += mfs[0].length;
					continue;
				}
			}
		}

		emit(c);
		prelude += c;
		i++;
	}
	return out;
}

// --- smallest runnable check: `node src/lib/rewrite.ts` -----------------------
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const assert = (got: string, want: string, msg: string) => {
		if (got !== want) throw new Error(`FAIL: ${msg}\n  got:  ${got}\n  want: ${want}`);
	};
	const map = new Map([
		['inter', '--font-inter'],
		['playfair display', '--font-playfair-display'],
	]);
	const r = (s: string) => rewriteFontFamily(s, map);
	assert(r('a{font-family:Inter,sans-serif}'), 'a{font-family:var(--font-inter),sans-serif}', 'replace primary');
	assert(r("a{font-family:'Playfair Display', serif}"), 'a{font-family:var(--font-playfair-display), serif}', 'quoted + spaced');
	assert(r('a{font-family:system-ui, Inter, serif}'), 'a{font-family:system-ui, var(--font-inter), serif}', 'non-first token');
	assert(r('a{font-family:var(--font-inter),sans-serif}'), 'a{font-family:var(--font-inter),sans-serif}', 'idempotent');
	assert(r('a{font-family:Roboto}'), 'a{font-family:Roboto}', 'unknown untouched');
	assert(r('a{--default-font-family:Inter}'), 'a{--default-font-family:Inter}', 'skip custom prop');
	assert(r('a{font-family:var(--x)}'), 'a{font-family:var(--x)}', 'var untouched');
	// #5 !important preserved
	assert(r('h1{font-family:Inter!important}'), 'h1{font-family:var(--font-inter)!important}', '!important no space');
	assert(r('h1{font-family:Inter , serif !important}'), 'h1{font-family:var(--font-inter) , serif !important}', '!important spaced');
	// #2 @font-face with a `}` inside a quoted src must NOT leak/rewrite its family
	assert(r('@font-face{src:url("g}.woff2");font-family:Inter}body{font-family:Inter}'),
		'@font-face{src:url("g}.woff2");font-family:Inter}body{font-family:var(--font-inter)}', '@font-face brace-in-string');
	// #3 font-family text inside a content string must be untouched
	assert(r('a{content:"font-family: Inter";color:red}'), 'a{content:"font-family: Inter";color:red}', 'string content');
	// Tailwind escaped-quote arbitrary selector
	assert(r(".font-\\[\\'Playfair_Display\\'\\]{font-family:Playfair Display}"),
		".font-\\[\\'Playfair_Display\\'\\]{font-family:var(--font-playfair-display)}", 'escaped selector');
	// plain @font-face skip
	assert(r('@font-face{font-family:Inter}'), '@font-face{font-family:Inter}', 'skip @font-face');
	// `font` shorthand
	assert(r('h1{font:700 2rem Inter}'), 'h1{font:700 2rem var(--font-inter)}', 'shorthand weight+size');
	assert(r("p{font:italic 16px/1.5 'Playfair Display', serif}"), "p{font:italic 16px/1.5 var(--font-playfair-display), serif}", 'shorthand style+lineheight+stack');
	assert(r('a{font:1em Inter !important}'), 'a{font:1em var(--font-inter) !important}', 'shorthand !important');
	assert(r('a{font:menu}'), 'a{font:menu}', 'shorthand system keyword untouched');
	assert(r('a{font:16px Roboto}'), 'a{font:16px Roboto}', 'shorthand unknown font untouched');
	assert(r('a{font-weight:700}'), 'a{font-weight:700}', 'font-weight not treated as shorthand');
	console.log('rewrite.ts checks OK');
}
