/// <reference lib="webworker" />

import * as ort from "onnxruntime-web";

const MODEL_SIZE = 256;
const INPUT_NAME = "pixel_values";
const MEAN = 0.5;
const STD = 0.5;

type InitRequest = {
  id: number;
  kind: "init";
  modelUrl: string;
};

type InferRequest = {
  id: number;
  kind: "infer";
  imageData: ImageData;
};

type WorkerRequest = InitRequest | InferRequest;

export type WorkerResponse =
  | {
      id: number;
      ok: true;
      kind: "init";
      backend: "webgpu" | "wasm";
      loadMs: number;
    }
  | {
      id: number;
      ok: true;
      kind: "infer";
      logits: Float32Array;
      inferenceMs: number;
      preprocessingMs: number;
    }
  | {
      id: number;
      ok: false;
      kind: "init" | "infer";
      error: string;
    };

declare const self: DedicatedWorkerGlobalScope;

let session: ort.InferenceSession | null = null;
let backend: "webgpu" | "wasm" = "wasm";

function supportsWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

function orthographicWasmPath(): string {
  return new URL("./ort/", self.location.href).href;
}

async function loadSession(modelUrl: string): Promise<void> {
  ort.env.wasm.wasmPaths = orthographicWasmPath();
  const started = performance.now();

  if (supportsWebGpu()) {
    try {
      session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: [{ name: "webgpu" }]
      });
      backend = "webgpu";
      console.info(
        `[vision] MobileViT loaded with WebGPU EP in ${(performance.now() - started).toFixed(1)} ms`
      );
      return;
    } catch (error) {
      console.warn(
        "[vision] WebGPU unavailable or session creation failed, falling back to WASM:",
        error
      );
    }
  }

  session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: [{ name: "wasm" }]
  });
  backend = "wasm";
  console.info(
    `[vision] MobileViT loaded with WASM EP in ${(performance.now() - started).toFixed(1)} ms`
  );
}

async function preprocess(imageData: ImageData): Promise<Float32Array> {
  const source = await createImageBitmap(imageData);
  const canvas = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("OffscreenCanvas 2D context unavailable");
  }

  context.drawImage(source, 0, 0, MODEL_SIZE, MODEL_SIZE);
  const resized = context.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  source.close();

  const pixels = MODEL_SIZE * MODEL_SIZE;
  const input = new Float32Array(3 * pixels);

  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4;
    input[i] = (resized[offset] / 255 - MEAN) / STD;
    input[pixels + i] = (resized[offset + 1] / 255 - MEAN) / STD;
    input[pixels + i * 2] = (resized[offset + 2] / 255 - MEAN) / STD;
  }

  return input;
}

async function handleRequest(request: WorkerRequest): Promise<WorkerResponse> {
  if (request.kind === "init") {
    const loadStarted = performance.now();

    try {
      await loadSession(request.modelUrl);
      return {
        id: request.id,
        ok: true,
        kind: "init",
        backend,
        loadMs: performance.now() - loadStarted
      };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        kind: "init",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  if (!session) {
    return {
      id: request.id,
      ok: false,
      kind: "infer",
      error: "Vision model not initialized"
    };
  }

  const preprocessStarted = performance.now();

  try {
    const input = await preprocess(request.imageData);
    const preprocessingMs = performance.now() - preprocessStarted;

    const inferenceStarted = performance.now();
    const tensor = new ort.Tensor("float32", input, [1, 3, MODEL_SIZE, MODEL_SIZE]);
    const results = await session.run({ [INPUT_NAME]: tensor });
    const inferenceMs = performance.now() - inferenceStarted;

    const logits = results.logits.data as Float32Array;
    console.info(
      `[vision] inference took ${inferenceMs.toFixed(1)} ms (${backend}), ` +
        `preprocessing ${preprocessingMs.toFixed(1)} ms, logits length ${logits.length}`
    );

    return {
      id: request.id,
      ok: true,
      kind: "infer",
      logits,
      inferenceMs,
      preprocessingMs
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      kind: "infer",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  void handleRequest(request).then((response) => {
    const transferables =
      response.kind === "infer" && response.ok ? [response.logits.buffer] : [];
    (self as unknown as Worker).postMessage(response, transferables);
  });
};