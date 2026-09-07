import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseBlazeFaceBoxes, boxIoU } from "../src/blazeface-parse.ts";

function row(x0: number, y0: number, x1: number, y1: number): Float32Array {
  const r = new Float32Array(16);
  r[0] = x0;
  r[1] = y0;
  r[2] = x1;
  r[3] = y1;
  return r;
}

const TWO_FACES = new Float32Array([
  ...row(0.2, 0.2, 0.5, 0.5), // face A
  ...row(0.6, 0.6, 0.9, 0.9) // face B (far away)
]);

const OVERLAP = new Float32Array([
  ...row(0.2, 0.2, 0.5, 0.5), // face A
  ...row(0.21, 0.2, 0.51, 0.5) // same face, jittered
]);

describe("parseBlazeFaceBoxes", () => {
  test("null / missing buffers degrade to an empty list, never crash", () => {
    assert.deepEqual(parseBlazeFaceBoxes(null, undefined, 128, 128), []);
    assert.deepEqual(parseBlazeFaceBoxes(undefined, [1, 4], 128, 128), []);
    assert.deepEqual(parseBlazeFaceBoxes(new Float32Array([]), [], 128, 128), []);
  });

  test("multiple overlapping faces are deduped by IoU into one detection", () => {
    const faces = parseBlazeFaceBoxes(OVERLAP, [1, 4], 100, 100);
    assert.equal(faces.length, 1);
  });

  test("distinct faces are all reported", () => {
    const faces = parseBlazeFaceBoxes(TWO_FACES, [1, 4], 100, 100);
    assert.equal(faces.length, 2);
    assert.deepEqual(faces[0].bbox, { x: 20, y: 20, w: 30, h: 30 });
    assert.deepEqual(faces[1].bbox, { x: 60, y: 60, w: 30, h: 30 });
  });

  test("detections are bounded by maxDetections", () => {
    const many = new Float32Array([
      ...row(0.1, 0.1, 0.2, 0.2),
      ...row(0.3, 0.1, 0.4, 0.2),
      ...row(0.5, 0.1, 0.6, 0.2),
      ...row(0.7, 0.1, 0.8, 0.2),
      ...row(0.1, 0.5, 0.2, 0.6)
    ]);
    const faces = parseBlazeFaceBoxes(many, [1, 5], 100, 100, 3);
    assert.equal(faces.length, 3);
  });

  test("NaN / inverted / zero-area rows are skipped without throwing", () => {
    const garbage = new Float32Array([
      ...row(NaN, 0, 0.5, 0.5),
      ...row(0.5, 0.5, 0.2, 0.2), // inverted
      ...row(0.1, 0.1, 0.1, 0.1), // zero area
      ...row(0.6, 0.6, 0.9, 0.9) // the only good one
    ]);
    const faces = parseBlazeFaceBoxes(garbage, [1, 4], 100, 100);
    assert.equal(faces.length, 1);
    assert.deepEqual(faces[0].bbox, { x: 60, y: 60, w: 30, h: 30 });
  });

  test("normalised coords are clamped and mapped to pixel space", () => {
    const offscreen = new Float32Array([...row(-0.5, 0, 1.5, 1)]);
    const faces = parseBlazeFaceBoxes(offscreen, [1, 1], 640, 480);
    assert.equal(faces.length, 1);
    assert.deepEqual(faces[0].bbox, { x: 0, y: 0, w: 640, h: 480 });
  });

  test("buffer smaller than dims claims does not read past the end", () => {
    const oneRow = new Float32Array([...row(0.1, 0.1, 0.3, 0.3)]);
    const faces = parseBlazeFaceBoxes(oneRow, [1, 99], 100, 100);
    assert.equal(faces.length, 1);
  });

  test("boxIoU sanity", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const same = { x: 0, y: 0, w: 10, h: 10 };
    const apart = { x: 100, y: 100, w: 10, h: 10 };
    assert.equal(boxIoU(a, same), 1);
    assert.equal(boxIoU(a, apart), 0);
  });
});