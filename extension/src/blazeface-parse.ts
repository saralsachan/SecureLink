/**
 * Pure parsing of raw BlazeFace "selectedBoxes" output into redaction boxes.
 * Kept free of onnxruntime/browser globals so it can be unit-tested in Node.
 *
 * Guards: missing/undersized buffers, non-finite or inverted coordinates,
 * zero-area boxes (skipped), excessive detections (bounded), and near-duplicate
 * overlapping boxes (merged by IoU).
 */
import type { BoundingBox } from "./dom-sensitivity.ts";

export type FaceDetection = {
  bbox: BoundingBox;
  confidence: number;
};

export const MAX_DETECTIONS = 4;
export const FACE_CONFIDENCE = 0.9;
export const BOX_STRIDE = 16;
/** Boxes whose pairwise IoU exceeds this are treated as one face (dedupe). */
export const IOU_DEDUPE_THRESHOLD = 0.75;

/** Clamp to [0, 1]; boxes are normalised fractions of the source image. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function boxIoU(a: BoundingBox, b: BoundingBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union <= 0 ? 0 : intersection / union;
}

export function parseBlazeFaceBoxes(
  boxes: Float32Array | undefined | null,
  dims: readonly number[] | undefined,
  imageWidth: number,
  imageHeight: number,
  maxDetections = MAX_DETECTIONS
): FaceDetection[] {
  const faces: FaceDetection[] = [];

  if (!boxes || !dims || dims.length < 2) {
    return faces;
  }

  const detectionCount = Math.min(dims[1], Math.floor(boxes.length / BOX_STRIDE));

  for (let i = 0; i < detectionCount && faces.length < maxDetections; i += 1) {
    const row = boxes.subarray(i * BOX_STRIDE, i * BOX_STRIDE + BOX_STRIDE);
    const x0 = row[0];
    const y0 = row[1];
    const x1 = row[2];
    const y1 = row[3];

    if (![x0, y0, x1, y1].every(Number.isFinite)) {
      continue;
    }

    if (x1 - x0 <= 0 || y1 - y0 <= 0) {
      continue;
    }

    const cx0 = clamp01(x0);
    const cy0 = clamp01(y0);
    const cx1 = clamp01(x1);
    const cy1 = clamp01(y1);

    const bbox: BoundingBox = {
      x: Math.round(cx0 * imageWidth),
      y: Math.round(cy0 * imageHeight),
      w: Math.round((cx1 - cx0) * imageWidth),
      h: Math.round((cy1 - cy0) * imageHeight)
    };

    if (bbox.w <= 0 || bbox.h <= 0) {
      continue;
    }

    if (faces.some((face) => boxIoU(face.bbox, bbox) > IOU_DEDUPE_THRESHOLD)) {
      continue;
    }

    faces.push({ bbox, confidence: FACE_CONFIDENCE });
  }

  return faces;
}