import Tesseract from "tesseract.js";
import type { OcrLine } from "./pii-detection";
import type { BoundingBox } from "./dom-sensitivity";

const { createWorker, OEM } = Tesseract;

let workerPromise: Promise<Tesseract.Worker> | null = null;

function tessAssetsBase(): string {
  return new URL("./tess/", self.location.href).href;
}

export async function initOcr(): Promise<void> {
  if (!workerPromise) {
    workerPromise = createWorker("eng", OEM.LSTM_ONLY, {
      workerPath: `${tessAssetsBase()}worker.min.js`,
      corePath: tessAssetsBase(),
      langPath: tessAssetsBase(),
      workerBlobURL: false,
      gzip: true,
      cacheMethod: "none",
      logger: (message) => {
        if (message.status !== "recognizing text") {
          console.info(
            `[vision] tesseract: ${message.status} ${Math.round(message.progress * 100)}%`
          );
        }
      }
    });
  }

  await workerPromise;
}

function toBoundingBox(box: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}): BoundingBox {
  return {
    x: Math.round(box.x0),
    y: Math.round(box.y0),
    w: Math.round(box.x1 - box.x0),
    h: Math.round(box.y1 - box.y0)
  };
}

function imageDataToCanvas(imageData: ImageData): OffscreenCanvas {
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("OffscreenCanvas 2D context unavailable");
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

export async function runOcr(imageData: ImageData): Promise<OcrLine[]> {
  await initOcr();

  const worker = workerPromise ? await workerPromise : null;

  if (!worker) {
    throw new Error("OCR worker not initialized");
  }

  const canvas = imageDataToCanvas(imageData);
  const result = await worker.recognize(canvas, {}, { text: true, blocks: true });
  const lines: OcrLine[] = [];

  for (const block of result.data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        lines.push({
          text: line.text,
          bbox: toBoundingBox(line.bbox),
          words: (line.words ?? []).map((word) => ({
            text: word.text,
            bbox: toBoundingBox(word.bbox)
          }))
        });
      }
    }
  }

  return lines;
}