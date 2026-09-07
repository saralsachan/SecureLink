import * as ort from "onnxruntime-web";
import {
  BOX_STRIDE,
  MAX_DETECTIONS,
  parseBlazeFaceBoxes,
  type FaceDetection
} from "./blazeface-parse.ts";

const MODEL_RELATIVE_URL = new URL("../models/blaze_face.onnx", self.location.href).href;
const MODEL_SIZE = 128;
const INPUT_NAME = "image";
const OUTPUT_NAME = "selectedBoxes";
const CONF_THRESHOLD = 0.6;
const IOU_THRESHOLD = 0.3;

function ortWasmPath(): string {
  return new URL("./ort/", self.location.href).href;
}

let session: ort.InferenceSession | null = null;

async function loadFaceSession(): Promise<void> {
  ort.env.wasm.wasmPaths = ortWasmPath();

  const started = performance.now();

  session = await ort.InferenceSession.create(MODEL_RELATIVE_URL, {
    executionProviders: [{ name: "wasm" }]
  });

  console.info(
    `[vision] BlazeFace loaded (WASM EP) in ${(performance.now() - started).toFixed(1)} ms`
  );
}

export async function initFaceDetector(): Promise<void> {
  if (!session) {
    await loadFaceSession();
  }
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
    input[i] = resized[offset] / 127.5 - 1;
    input[pixels + i] = resized[offset + 1] / 127.5 - 1;
    input[pixels + i * 2] = resized[offset + 2] / 127.5 - 1;
  }

  return input;
}

export async function detectFaces(imageData: ImageData): Promise<FaceDetection[]> {
  await initFaceDetector();

  if (!session) {
    throw new Error("BlazeFace session not initialized");
  }

  const inputName = session.inputNames.find((name) => name === INPUT_NAME) ?? INPUT_NAME;
  const input = await preprocess(imageData);

  const feeds: Record<string, ort.Tensor> = {
    [inputName]: new ort.Tensor("float32", input, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    conf_threshold: new ort.Tensor("float32", new Float32Array([CONF_THRESHOLD]), [1]),
    max_detections: new ort.Tensor("int64", BigInt64Array.from([BigInt(MAX_DETECTIONS)]), [1]),
    iou_threshold: new ort.Tensor("float32", new Float32Array([IOU_THRESHOLD]), [1])
  };

  const results = await session.run(feeds);
  const output = results[OUTPUT_NAME];
  const boxes = output?.data as Float32Array | undefined;
  const dims = output?.dims as readonly number[] | undefined;

  return parseBlazeFaceBoxes(boxes, dims, imageData.width, imageData.height);
}