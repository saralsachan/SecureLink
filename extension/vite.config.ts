import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const rootDir = __dirname;

function copyToOutDirPlugin(): Plugin {
  let outDir = "";

  return {
    name: "securelink-copy-assets",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const onnxRuntimeDist = resolve(rootDir, "node_modules/onnxruntime-web/dist");
      const ortTarget = resolve(outDir, "assets/ort");
      mkdirSync(ortTarget, { recursive: true });

      for (const fileName of readdirSync(onnxRuntimeDist)) {
        if (!fileName.startsWith("ort-wasm")) {
          continue;
        }
        writeFileSync(
          resolve(ortTarget, fileName),
          readFileSync(resolve(onnxRuntimeDist, fileName))
        );
      }

      const modelsTarget = resolve(outDir, "models");
      mkdirSync(modelsTarget, { recursive: true });

      for (const fileName of readdirSync(resolve(rootDir, "models"))) {
        writeFileSync(
          resolve(modelsTarget, fileName),
          readFileSync(resolve(rootDir, "models", fileName))
        );
      }
    }
  };
}

export default defineConfig({
  build: {
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(rootDir, "popup.html"),
        background: resolve(rootDir, "src/background.ts"),
        content: resolve(rootDir, "src/content.ts")
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  plugins: [copyToOutDirPlugin()]
});