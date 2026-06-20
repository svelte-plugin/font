// Ambient declaration so `import 'virtual:font.css'` typechecks in consumer code
// (e.g. src/routes/+layout.svelte). The plugin serves this module at build/dev.
declare module 'virtual:font.css';
