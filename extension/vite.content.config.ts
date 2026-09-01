import { resolve } from "node:path";
import { defineConfig } from "vite";

// Dedicated build for the content script.
//
// Chrome content scripts (both manifest `content_scripts` and those injected via
// `chrome.scripting.executeScript`) run as *classic* scripts. They cannot contain
// top-level ES module `import`/`export` statements. A single self-contained entry
// makes Rollup inline every dependency into one IIFE with no cross-chunk imports,
// so the registered `chrome.runtime.onMessage` listener always boots.
const rootDir = __dirname;

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(rootDir, "src/content.ts"),
      output: {
        entryFileNames: "assets/content.js",
        assetFileNames: "assets/[name][extname]",
        format: "iife",
        inlineDynamicImports: true
      }
    }
  }
});