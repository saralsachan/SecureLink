import type {
  WorkerResponse,
  AnalysisTimings
} from "./vision.worker.ts";
import type { VisualSensitivityHit } from "./dom-sensitivity.ts";

const DEFAULT_MODEL_RELATIVE_URL = "models/mobilevit_xxs_int8.onnx";

/** Bounds for each worker round-trip so a stuck stage degrades instead of hanging. */
const CALL_TIMEOUT_MS = {
  init: 120_000,
  infer: 60_000,
  analyse: 120_000
} as const;

type CallKind = "init" | "infer" | "analyse";

type CallInit = { kind: "init"; modelUrl: string };
type CallInfer = { kind: "infer"; imageData: ImageData };
type CallAnalyse = { kind: "analyse"; imageData: ImageData };

export type VisionAnalysis = {
  hits: VisualSensitivityHit[];
  timings: AnalysisTimings;
};

let worker: Worker | null = null;
let idCounter = 0;
let initPromise: Promise<"webgpu" | "wasm"> | null = null;

const pending = new Map<number, (response: WorkerResponse) => void>();

function modelUrl(): string {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(DEFAULT_MODEL_RELATIVE_URL);
  }
  return DEFAULT_MODEL_RELATIVE_URL;
}

function ensureWorker(): Worker {
  if (worker) {
    return worker;
  }

  const created = new Worker(new URL("./vision.worker.ts", import.meta.url), {
    type: "module",
    name: "securelink-vision"
  });
  worker = created;

  created.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const resolve = pending.get(response.id);

    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  };

  created.onerror = (event) => {
    console.error("[vision] worker error:", event.message);
    for (const resolve of pending.values()) {
      resolve({ id: -1, ok: false, kind: "infer", error: event.message });
    }
    pending.clear();
    // The worker is broken; recreate it on the next request.
    created.terminate();
    worker = null;
  };

  return created;
}

function call<T extends WorkerResponse>(
  request: CallInit | CallInfer | CallAnalyse
): Promise<T> {
  const id = idCounter++;
  const idRequest = { ...request, id };
  const timeoutMs = CALL_TIMEOUT_MS[request.kind];

  const responsePromise = new Promise<T>((resolve, reject) => {
    pending.set(id, resolve as (response: WorkerResponse) => void);

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          `Vision stage '${request.kind}' timed out after ${Math.round(timeoutMs / 1000)}s`
        )
      );
    }, timeoutMs);

    const original = pending.get(id) as (response: WorkerResponse) => void;
    pending.set(id, (response) => {
      clearTimeout(timer);
      original(response);
    });

    try {
      ensureWorker().postMessage(idRequest);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return responsePromise;
}

export async function initVisionModel(): Promise<"webgpu" | "wasm"> {
  if (!initPromise) {
    initPromise = (async () => {
      const response = await call<WorkerResponse>({
        kind: "init",
        modelUrl: modelUrl()
      });

      if (!response.ok || response.kind !== "init") {
        const error = !response.ok ? response.error : "Unexpected worker response";
        throw new Error(`Vision model initialization failed: ${error}`);
      }

      console.info(`[vision] backend: ${response.backend} (load ${response.loadMs.toFixed(1)} ms)`);
      return response.backend;
    })().catch((error: unknown) => {
      // Allow a later retry: model file missing / GPU fallback chain exhausted.
      initPromise = null;
      throw error;
    });
  }

  return initPromise;
}

export async function runVisionModel(imageData: ImageData): Promise<Float32Array> {
  await initVisionModel();

  const response = await call<WorkerResponse>({
    kind: "infer",
    imageData
  });

  if (!response.ok || response.kind !== "infer") {
    const error = !response.ok ? response.error : "Unexpected worker response";
    throw new Error(`Vision inference failed: ${error}`);
  }

  return response.logits;
}

export function getVisionBackend(): Promise<"webgpu" | "wasm"> {
  return initVisionModel();
}

export async function runVisionAnalysis(imageData: ImageData): Promise<VisionAnalysis> {
  const response = await call<WorkerResponse>({
    kind: "analyse",
    imageData
  });

  if (!response.ok || response.kind !== "analyse") {
    const error = !response.ok ? response.error : "Unexpected worker response";
    throw new Error(`Vision analysis failed: ${error}`);
  }

  return {
    hits: response.hits,
    timings: response.timings
  };
}