<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	// Tailwind v4 utilities. The plugin auto-injects its generated font stylesheet
	// here, so no manual font import is needed.
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
