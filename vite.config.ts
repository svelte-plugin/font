import adapter from "@sveltejs/adapter-auto";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import font from "./src/lib/index.ts";

export default defineConfig({
  plugins: [
    // Demo: one sans (auto-detected via a heading) + one mono, served from the
    // Google CDN. autoDetect scans src/ and narrows to families actually used.
    font({
      fonts: [
        "Inter",
        {
          family: "JetBrains Mono",
          preload: true,
        },
      ],
      debug: true,
      autoDetect: true,
    }),
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },

      // adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
      // If your environment is not supported, or you settled on a specific environment, switch out the adapter.
      // See https://svelte.dev/docs/kit/adapters for more information about adapters.
      adapter: adapter(),
    }),
  ],
});
