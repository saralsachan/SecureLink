import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "node:fs";
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

      const ortWasmFiles = readdirSync(onnxRuntimeDist).filter((fileName) =>
        fileName.startsWith("ort-wasm")
      );

      for (const fileName of ortWasmFiles) {
        writeFileSync(
          resolve(ortTarget, fileName),
          readFileSync(resolve(onnxRuntimeDist, fileName))
        );
      }

      const modelsTarget = resolve(outDir, "models");
      mkdirSync(modelsTarget, { recursive: true });

      const modelFiles = readdirSync(resolve(rootDir, "models")).filter((fileName) =>
        statSync(resolve(rootDir, "models", fileName)).isFile()
      );

      for (const fileName of modelFiles) {
        writeFileSync(
          resolve(modelsTarget, fileName),
          readFileSync(resolve(rootDir, "models", fileName))
        );
      }

      const tessTarget = resolve(outDir, "assets/tess");
      mkdirSync(tessTarget, { recursive: true });

      const tessDir = resolve(rootDir, "node_modules/tesseract.js-core");
      const coreVariants = [
        "tesseract-core-relaxedsimd-lstm.wasm.js",
        "tesseract-core-relaxedsimd-lstm.wasm",
        "tesseract-core-simd-lstm.wasm.js",
        "tesseract-core-simd-lstm.wasm",
        "tesseract-core-lstm.wasm.js",
        "tesseract-core-lstm.wasm"
      ];

      for (const fileName of coreVariants) {
        writeFileSync(
          resolve(tessTarget, fileName),
          readFileSync(resolve(tessDir, fileName))
        );
      }

      writeFileSync(
        resolve(tessTarget, "worker.min.js"),
        readFileSync(resolve(rootDir, "node_modules/tesseract.js/dist/worker.min.js"))
      );

      writeFileSync(
        resolve(tessTarget, "eng.traineddata.gz"),
        readFileSync(
          resolve(
            rootDir,
            "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"
          )
        )
      );
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