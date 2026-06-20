<h1>Welcome to svelte-plugin-font</h1>

<p class="font-sans">
	This paragraph uses Tailwind's <code class="font-mono">font-sans</code> utility — the plugin
	wires <code class="font-mono">--font-sans</code> to the Inter stack (web font + a
	metric-matched fallback) with no <code>@font-face</code> rule and no import.
</p>

<pre class="font-mono">const greeting = "JetBrains Mono via font-mono";</pre>

<p>
	A raw CSS declaration works too — <span class="quote">Playfair Display</span> is
	auto-detected from this file, loaded, and rewritten to its metric-matched stack.
</p>

<p>
	Visit <a href="https://svelte.dev/docs/kit">svelte.dev/docs/kit</a> to read the documentation.
</p>

<style>
	h1 {
		font-size: 2rem;
		font-weight: 700;
	}

	/* A bare font-family for a Google font: auto-detected and rewritten to
	   var(--font-playfair-display) by the plugin (no @font-face needed). */
	.quote {
		font-family: 'Playfair Display', serif;
	}
</style>
