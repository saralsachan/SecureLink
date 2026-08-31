import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { BoundingBox, SensitiveHit, VisualSensitivityHit } from "../src/dom-sensitivity";
import {
  redactStructuralMap,
  selfVerifyRedaction,
  getRedactionKey,
  type RedactHit
} from "../src/redaction.ts";
import { redact } from "../src/redaction.ts";

function bbox(x: number, y: number, w: number, h: number): BoundingBox {
  return { x, y, w, h };
}

function hit(elementId: string, sensitivityClass: string): RedactHit {
  return { bbox: bbox(10, 20, 100, 30), sensitivityClass };
}

function domHit(elementId: string, sensitivityClass: SensitiveHit["sensitivityClass"]): SensitiveHit {
  return { elementId, sensitivityClass, confidence: 1, source: "dom" };
}

function fakeNode(overrides: Partial<{
  id: string;
  tag: string;
  role: string | null;
  bbox: BoundingBox;
  inputType: string | null;
  ariaLabel: string | null;
  autocomplete: string | null;
  placeholder: string | null;
  value: string | null;
}> & { id: string }) {
  return {
    id: overrides.id,
    tag: overrides.tag ?? "input",
    role: overrides.role ?? "textbox",
    bbox: overrides.bbox ?? { x: 0, y: 0, w: 40, h: 24 },
    inputType: overrides.inputType ?? null,
    ariaLabel: overrides.ariaLabel ?? null,
    autocomplete: overrides.autocomplete ?? null,
    placeholder: overrides.placeholder ?? null,
    value: overrides.value ?? null
  };
}

describe("redactStructuralMap", () => {
  test("replaces input value with a redaction token", () => {
    const map = [fakeNode({ id: "pw", value: "secret123", inputType: "password" })];
    const hits = [domHit("pw", "password")];

    const { redactedMap, redactionKey } = redactStructuralMap(map, hits);

    assert.equal(redactedMap[0].value, "[REDACTED_PASSWORD_1]");
    assert.equal(redactionKey.get("[REDACTED_PASSWORD_1]"), "secret123");
  });

  test("replaces placeholder when value is absent", () => {
    const map = [fakeNode({ id: "email", placeholder: "Email address", ariaLabel: null, value: null })];
    const hits = [domHit("email", "email")];

    const { redactedMap, redactionKey } = redactStructuralMap(map, hits);

    assert.equal(redactedMap[0].placeholder, "[REDACTED_EMAIL_1]");
    assert.equal(redactionKey.get("[REDACTED_EMAIL_1]"), "Email address");
  });

  test("replaces ariaLabel when value and placeholder are absent", () => {
    const map = [fakeNode({ id: "ssn", ariaLabel: "Social Security Number", value: null, placeholder: null })];
    const hits = [domHit("ssn", "ssn")];

    const { redactedMap, redactionKey } = redactStructuralMap(map, hits);

    assert.equal(redactedMap[0].ariaLabel, "[REDACTED_SSN_1]");
    assert.equal(redactionKey.get("[REDACTED_SSN_1]"), "Social Security Number");
  });

  test("skips elements with no text fields to redact", () => {
    const map = [fakeNode({ id: "btn", value: null, placeholder: null, ariaLabel: null })];
    const hits = [domHit("btn", "password")];

    const { redactedMap, redactionKey } = redactStructuralMap(map, hits);

    assert.equal(redactedMap[0].value, null);
    assert.equal(redactionKey.size, 0);
  });

  test("deduplicates multiple hits on the same element and class", () => {
    const map = [fakeNode({ id: "pw", value: "secret" })];
    const hits = [domHit("pw", "password"), domHit("pw", "password")];

    const { redactedMap, redactionKey } = redactStructuralMap(map, hits);

    assert.equal(redactedMap[0].value, "[REDACTED_PASSWORD_1]");
    assert.equal(redactionKey.size, 1);
  });

  test("assigns incrementing indices per class across elements", () => {
    const map = [
      fakeNode({ id: "a", value: "x" }),
      fakeNode({ id: "b", value: "y" })
    ];
    const hits = [domHit("a", "email"), domHit("b", "email")];

    const { redactedMap, redactionKey } = redactStructuralMap(map, hits);

    assert.equal(redactedMap[0].value, "[REDACTED_EMAIL_1]");
    assert.equal(redactedMap[1].value, "[REDACTED_EMAIL_2]");
    assert.equal(redactionKey.get("[REDACTED_EMAIL_1]"), "x");
    assert.equal(redactionKey.get("[REDACTED_EMAIL_2]"), "y");
  });

  test("normalizes class names to uppercase with underscores", () => {
    const map = [fakeNode({ id: "c", value: "1234" })];
    const hits = [domHit("c", "card-number")];

    const { redactedMap } = redactStructuralMap(map, hits);

    assert.equal(redactedMap[0].value, "[REDACTED_CARD_NUMBER_1]");
  });

  test("returns a deep-copied map", () => {
    const map = [fakeNode({ id: "pw", value: "secret" })];
    const hits = [domHit("pw", "password")];

    const { redactedMap } = redactStructuralMap(map, hits);

    assert.equal(redactedMap[0].value, "[REDACTED_PASSWORD_1]");
    assert.equal(map[0].value, "secret");
  });

  test("getRedactionKey returns the in-memory store", () => {
    const map = [fakeNode({ id: "pw", value: "s" })];
    const hits = [domHit("pw", "password")];

    redactStructuralMap(map, hits);

    assert.equal(getRedactionKey().get("[REDACTED_PASSWORD_1]"), "s");
  });
});

describe("redact", () => {
  test("draws a solid black box over each hit bbox", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D context unavailable");
    }
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 200, 100);

    const result = redact(canvas, [hit("x", "face")], { method: "black", padding: 0 });
    const rctx = result.getContext("2d");
    if (!rctx) {
      throw new Error("2D context unavailable");
    }
    const pixel = rctx.getImageData(10, 20, 1, 1).data;

    assert.equal(pixel[0], 0);
    assert.equal(pixel[1], 0);
    assert.equal(pixel[2], 0);
  });

  test("applies padding around the bbox", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D context unavailable");
    }
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 200, 100);

    const result = redact(canvas, [hit("x", "face")], { method: "black", padding: 5 });
    const rctx = result.getContext("2d");
    if (!rctx) {
      throw new Error("2D context unavailable");
    }

    const inside = rctx.getImageData(14, 24, 1, 1).data;
    const outside = rctx.getImageData(4, 14, 1, 1).data;

    assert.equal(inside[0], 0);
    assert.equal(outside[0], 255);
  });

  test("applies a gaussian blur when method is blur", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D context unavailable");
    }
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 200, 100);

    const result = redact(canvas, [hit("x", "face")], { method: "blur", padding: 0, blurRadius: 8 });
    const rctx = result.getContext("2d");
    if (!rctx) {
      throw new Error("2D context unavailable");
    }
    const pixel = rctx.getImageData(15, 25, 1, 1).data;

    assert.ok(
      pixel[0] > 0 && pixel[0] < 255,
      "blurred pixel should be a blend, got " + pixel[0]
    );
  });

  test("skips zero-area hits", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D context unavailable");
    }
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 200, 100);

    const result = redact(canvas, [{ bbox: { x: 10, y: 20, w: 0, h: 0 }, sensitivityClass: "face" }], {
      method: "black",
      padding: 0
    });

    const rctx = result.getContext("2d");
    if (!rctx) {
      throw new Error("2D context unavailable");
    }
    const pixel = rctx.getImageData(10, 20, 1, 1).data;

    assert.equal(pixel[0], 255);
  });

  test("returns a new canvas without mutating the source", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D context unavailable");
    }
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, 200, 100);

    const result = redact(canvas, [hit("x", "face")], { method: "black" });

    assert.equal(result.width, 200);
    assert.equal(result.height, 100);
    assert.notStrictEqual(result, canvas);
    const srcPixel = ctx.getImageData(10, 20, 1, 1).data;
    assert.equal(srcPixel[1], 255);
  });
});

describe("selfVerifyRedaction", () => {
  function makeHit(): RedactHit {
    return { bbox: bbox(10, 20, 100, 30), sensitivityClass: "email" };
  }

  function makeCanvas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    return canvas;
  }

  test("returns safe when pipeline produces no remaining hits", async () => {
    const canvas = makeCanvas();
    const pipeline = {
      runOcr: async () => [],
      classifyOcrLines: () => [],
    };

    const result = await selfVerifyRedaction(canvas, [makeHit()], pipeline);

    assert.equal(result.safe, true);
    assert.equal(result.blocked, false);
    assert.equal(result.remainingHits.length, 0);
  });

  test("blocks when failClosed is true and hits remain", async () => {
    const canvas = makeCanvas();
    const pipeline = {
      runOcr: async () => [],
      classifyOcrLines: () => [
        {
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          sensitivityClass: "email",
          confidence: 0.9,
          source: "visual",
        },
      ],
    };

    const result = await selfVerifyRedaction(canvas, [makeHit()], pipeline, {
      failClosed: true,
    });

    assert.equal(result.safe, false);
    assert.equal(result.blocked, true);
    assert.equal(result.remainingHits.length, 1);
  });

  test("retries with larger padding when failClosed is false", async () => {
    const canvas = makeCanvas();
    let callCount = 0;
    const pipeline = {
      runOcr: async () => [],
      classifyOcrLines: () => {
        callCount++;
        if (callCount === 1) {
          return [
            {
              bbox: { x: 0, y: 0, w: 10, h: 10 },
              sensitivityClass: "email",
              confidence: 0.9,
              source: "visual",
            },
          ];
        }
        return [];
      },
    };

    const result = await selfVerifyRedaction(canvas, [makeHit()], pipeline, {
      failClosed: false,
    });

    assert.equal(result.safe, true);
    assert.equal(result.blocked, false);
  });
});