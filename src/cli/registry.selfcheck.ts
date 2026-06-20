// Standalone self-check for src/cli/registry.ts.
//
// Run with: node src/cli/registry.selfcheck.ts   (Node 24 strips the TS types)
//
// This file is NEVER imported by index.ts and is NEVER an esbuild entry, so its
// side effects can never reach the bundled dist/cli.js. Keep all registry
// assertions here instead of inline in registry.ts.

import { GOOGLE_FONT_NAMES } from '../lib/generated/google-fonts.ts';
import {
	getFontChoices,
	fontOptions,
	resolveFontNames,
	isGoogleFont,
	categoryHint,
} from './registry.ts';

const assert = (cond: boolean, msg: string): void => {
	if (!cond) {
		console.error('registry self-check FAILED:', msg);
		process.exit(1);
	}
};

const choices = getFontChoices();

assert(choices.length === GOOGLE_FONT_NAMES.length, 'choice count == name count');
assert(choices.length >= 1936, `expected >= 1936 fonts, got ${choices.length}`);
assert(fontOptions().length === choices.length, 'fontOptions matches getFontChoices');

// Known entry: Inter is a sans variable Google font.
const inter = choices.find((c) => c.value === 'Inter');
assert(!!inter, 'Inter present in choices');
assert(inter!.label === 'Inter' && inter!.value === 'Inter', 'Inter value === label');
assert(isGoogleFont('Inter'), 'isGoogleFont(Inter)');
assert(!isGoogleFont('Definitely Not A Font 123'), 'isGoogleFont rejects unknown');
assert(categoryHint('Inter') === 'sans', 'categoryHint(Inter) === sans');
assert(categoryHint('Definitely Not A Font 123') === undefined, 'categoryHint unknown undefined');

// Case-insensitive resolution -> canonical name.
const r1 = resolveFontNames(['inter', '  JETBRAINS mono ', '']);
assert(r1.fonts.includes('Inter'), 'resolves inter -> Inter');
assert(!r1.unknown.includes('Inter'), 'Inter not unknown');

// Dedup: case variants collapse to a single canonical name.
const rDedup = resolveFontNames(['Inter', 'inter', 'INTER']);
assert(
	rDedup.fonts.length === 1 && rDedup.fonts[0] === 'Inter',
	`dedup collapses case variants, got ${JSON.stringify(rDedup.fonts)}`,
);

// Unknown family kept verbatim in non-strict mode, isolated in strict mode.
const r2 = resolveFontNames(['Inter', 'My Local Face']);
assert(r2.fonts.includes('My Local Face'), 'non-strict keeps unknown in fonts');
assert(r2.unknown.includes('My Local Face'), 'unknown reported');
const r3 = resolveFontNames(['Inter', 'My Local Face'], { strict: true });
assert(!r3.fonts.includes('My Local Face'), 'strict drops unknown from fonts');
assert(r3.fonts.includes('Inter') && r3.unknown.includes('My Local Face'), 'strict split correct');

// Repeated unknowns dedupe too.
const r4 = resolveFontNames(['My Face', 'My Face']);
assert(r4.fonts.length === 1 && r4.unknown.length === 1, 'repeated unknowns deduped');

console.log(`registry self-check OK — ${choices.length} fonts, hint e.g. Inter: "${inter!.hint}"`);
