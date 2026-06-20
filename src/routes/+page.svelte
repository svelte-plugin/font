<h1 class="font-serif" >Welcome to svelte-plugin-font</h1>

<!-- Demo of a LOCAL self-hosted font (BINARY-ONLY scanning): the woff2 file lives
     at static/fonts/Demo Local/variable.woff2, but the filename and directory name
     carry NO meaning. fontkit reads the binary and reports its real family
     "Recursive Sans Linear Light" (a static 400 face — the "variable" filename is
     deliberately ignored). The `font-family` below is auto-detected and rewritten to
     var(--font-recursive-sans-linear-light). -->
<h2 class="local-demo">Local self-hosted heading (Recursive Sans Linear Light)</h2>

<p class="font-sans">
	This paragraph uses the Tailwind <code class="font-mono">font-sans</code> utility, which
	compiles to <code class="font-mono">font-family: var(--font-sans)</code>. The plugin sets
	<code class="font-mono">--font-sans</code> to the Inter stack (web font + a metric-matched
	fallback) via the generated <code class="font-mono">virtual:font.css</code>.
</p>

<!-- font-mono compiles to font-family: var(--font-mono); the .snippet rule below
     declares "JetBrains Mono" so the auto-detector keeps this font in the build. -->
<pre class="snippet">const greeting = "JetBrains Mono via font-mono";</pre>

<p>
	Visit <a href="https://svelte.dev/docs/kit">svelte.dev/docs/kit</a> to read the documentation.
</p>


<h2 class="font-['IBM_Plex_Mono']"> IBM Plex Mono</h2>
<style>
	/* Bare font-family declarations so the auto-detector picks up both demo
	   families ("Inter" and "JetBrains Mono"). */
	h1 {		
		font-size: 2rem;
		font-weight: 700;
	}

	.snippet {
		font-family: 'Google Sans Flex', monospace;
	}

	/* Local self-hosted family — the CSS family is the font's BINARY familyName
	   ("Recursive Sans Linear Light"), NOT the "Demo Local" directory or "variable"
	   filename. Auto-detected and rewritten to
	   var(--font-recursive-sans-linear-light) by the plugin. */
	.local-demo {
		font-family: 'Recursive Sans Linear Light', sans-serif;
		font-size: 1.5rem;
		font-weight: 600;
	}
</style>
