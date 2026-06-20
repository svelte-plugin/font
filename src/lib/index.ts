// ============================================================================
// src/lib/index.ts — Package entrypoint
// Re-exports the plugin factory (default + named) and the public types, and
// declares the virtual module so consumers' `import 'virtual:font.css'` types.
// ============================================================================

/// <reference path="./client.d.ts" />

export { default } from './plugin.js';
export { default as fontPlugin } from './plugin.js';

export type {
	FontPluginOptions,
	FontEntry,
	FamilyName,
	FontCategory,
	FontSource,
	FontProvider,
	FontStyle,
	FontDisplay,
	TailwindMode,
} from './options.js';

export type { GoogleFontName } from './generated/google-fonts.js';
