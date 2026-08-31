import type {
  WorkerResponse,
  AnalysisTimings
} from "./vision.worker";
import type { VisualSensitivityHit } from "./dom-sensitivity";

const DEFAULT_MODEL_RELATIVE_URL = "models/mobilevit_xxs_int8.onnx";

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

  worker = new Worker(new URL("./vision.worker.ts", import.meta.url), {
    type: "module",
    name: "securelink-vision"
  });

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const resolve = pending.get(response.id);

    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  };

  worker.onerror = (event) => {
    console.error("[vision] worker error:", event.message);
    for (const resolve of pending.values()) {
      resolve({ id: -1, ok: false, kind: "infer", error: event.message });
    }
    pending.clear();
  };

  return worker;
}

function call<T extends WorkerResponse>(request: CallInit | CallInfer | CallAnalyse): Promise<T> {
  const id = idCounter++;
  const idRequest = { ...request, id };

  const responsePromise = new Promise<T>((resolve) => {
    pending.set(id, resolve as (response: WorkerResponse) => void);
    ensureWorker().postMessage(idRequest);
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
    })();
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