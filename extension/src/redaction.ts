import { detectSensitiveDomElements, type BoundingBox, type ElementNode, type SensitiveHit, type VisualSensitivityHit } from "./dom-sensitivity.ts";
import type { OcrLine } from "./pii-detection.ts";

export const FAIL_CLOSED = true;
export const DEFAULT_REDACTION_PADDING = 4;
export const REDACTION_PADDING_INCREASE = 10;
export const MIN_REDACTION_CONFIDENCE = 0.5;

export type RedactOptions = {
  method?: "black" | "blur";
  padding?: number;
  blurRadius?: number;
  createCanvas?: () => HTMLCanvasElement;
};

export type RedactHit = {
  bbox: BoundingBox;
  sensitivityClass: string;
};

export type OcrPipeline = {
  runOcr: (canvas: HTMLCanvasElement) => Promise<OcrLine[]>;
  classifyOcrLines: (lines: OcrLine[]) => VisualSensitivityHit[];
};

function expandBbox(bbox: BoundingBox, amount: number): BoundingBox {
  return {
    x: bbox.x - amount,
    y: bbox.y - amount,
    w: bbox.w + 2 * amount,
    h: bbox.h + 2 * amount,
  };
}

function isBoxCovered(inner: BoundingBox, outer: BoundingBox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export async function selfVerifyRedaction(
  originalCanvas: HTMLCanvasElement,
  hits: RedactHit[],
  pipeline: OcrPipeline,
  options?: {
    failClosed?: boolean;
    paddingIncrease?: number;
    minConfidence?: number;
    createCanvas?: () => HTMLCanvasElement;
  }
): Promise<{
  safe: boolean;
  blocked: boolean;
  redactedCanvas: HTMLCanvasElement;
  remainingHits: VisualSensitivityHit[];
}> {
  const failClosed = options?.failClosed ?? FAIL_CLOSED;
  const paddingIncrease = options?.paddingIncrease ?? REDACTION_PADDING_INCREASE;
  const minConfidence = options?.minConfidence ?? MIN_REDACTION_CONFIDENCE;

  const doRedact = (padding: number): HTMLCanvasElement => {
    const expandedHits = hits.map((hit) => ({
      ...hit,
      bbox: expandBbox(hit.bbox, padding),
    }));
    return redact(originalCanvas, expandedHits, { method: "black", padding: 0, createCanvas: options?.createCanvas });
  };

  const getRemainingHits = async (canvas: HTMLCanvasElement): Promise<VisualSensitivityHit[]> => {
    const lines = await pipeline.runOcr(canvas);
    const piiHits = pipeline.classifyOcrLines(lines);
    return piiHits.filter((h) => h.confidence >= minConfidence);
  };

  let redactedCanvas = doRedact(DEFAULT_REDACTION_PADDING);
  let remaining = await getRemainingHits(redactedCanvas);

  if (remaining.length === 0) {
    return { safe: true, blocked: false, redactedCanvas, remainingHits: [] };
  }

  if (failClosed) {
    return { safe: false, blocked: true, redactedCanvas, remainingHits: remaining };
  }

  redactedCanvas = doRedact(DEFAULT_REDACTION_PADDING + paddingIncrease);
  remaining = await getRemainingHits(redactedCanvas);

  return {
    safe: remaining.length === 0,
    blocked: false,
    redactedCanvas,
    remainingHits: remaining,
  };
}

const redactionKey = new Map<string, string>();
const nextIndex = new Map<string, number>();

export function getRedactionKey(): ReadonlyMap<string, string> {
  return redactionKey;
}

const REDACTED_TOKEN_RE = /\[REDACTED_[A-Z0-9_]+(?:_\d+)?\]/g;

/**
 * Resolve every `[REDACTED_*]` token in *value* to its real value using the
 * local redaction key. Tokens with no matching entry are left untouched.
 */
export function resolveTokens(
  value: string,
  redactionKey?: ReadonlyMap<string, string> | null
): string {
  if (!redactionKey || redactionKey.size === 0) {
    return value;
  }
  return value.replace(
    REDACTED_TOKEN_RE,
    (token) => redactionKey.get(token) ?? token
  );
}

/**
 * Persistent redaction tracker for delta-based sync (Phase 2).
 *
 * Unlike `redactStructuralMap` (which clears and rebuilds the key every call),
 * this keeps one stable redaction key across a session and re-tokenizes only
 * the given element ids. Stable tokens mean a field typed over several steps
 * keeps the same `[REDACTED_*]` placeholder instead of churning the key, and
 * `resolveTokens` can always map it back to the latest real value.
 */
export type RedactionTracker = ReturnType<typeof createRedactionTracker>;

export function createRedactionTracker(): {
  /** Re-tokenize *ids* in-place within *map*; other elements are untouched. */
  redactNodes(map: ElementNode[], ids: string[]): void;
  getRedactionKey(): ReadonlyMap<string, string>;
  redactionKeySize(): number;
} {
  const key = new Map<string, string>();
  const tokenFor = new Map<string, Map<string, string>>(); // elementId -> class -> token
  const nextIndex = new Map<string, number>();

  function tokenForClass(elementId: string, cls: string, realValue: string): string {
    const byClass = tokenFor.get(elementId) ?? new Map<string, string>();
    let token = byClass.get(cls);

    if (!token) {
      const index = (nextIndex.get(cls) ?? 0) + 1;
      nextIndex.set(cls, index);
      token = `[REDACTED_${cls.toUpperCase().replace(/-/g, "_")}_${index}]`;
      byClass.set(cls, token);
      tokenFor.set(elementId, byClass);
    }

    // Re-register the *current* real value so resolveTokens maps the token to
    // the latest typed value.
    key.set(token, realValue ?? token);
    return token;
  }

  return {
    redactNodes(map: ElementNode[], ids: string[]): void {
      const byId = new Map(map.map((n) => [n.id, n]));

      for (const id of ids) {
        const node = byId.get(id);

        if (!node) {
          continue;
        }

        const hits = detectSensitiveDomElements([node]);

        if (hits.length === 0) {
          continue;
        }

        const realValue = node.value ?? node.placeholder ?? node.ariaLabel;

        if (realValue == null) {
          continue;
        }

        const seen = new Set<string>();
        for (const hit of hits) {
          if (seen.has(hit.sensitivityClass)) {
            continue;
          }
          seen.add(hit.sensitivityClass);
          const token = tokenForClass(node.id, hit.sensitivityClass, realValue);

          if (node.value != null) {
            node.value = token;
          }
          if (node.placeholder != null) {
            node.placeholder = token;
          }
          if (node.ariaLabel != null) {
            node.ariaLabel = token;
          }
        }
      }
    },
    getRedactionKey(): ReadonlyMap<string, string> {
      return key;
    },
    redactionKeySize(): number {
      return key.size;
    }
  };
}

export function redactStructuralMap(
  map: ElementNode[],
  domHits: SensitiveHit[]
): { redactedMap: ElementNode[]; redactionKey: ReadonlyMap<string, string> } {
  redactionKey.clear();
  nextIndex.clear();

  const redactedMap = map.map((node) => ({ ...node }));
  const nodeById = new Map(redactedMap.map((n) => [n.id, n]));

  const seen = new Set<string>();
  for (const hit of domHits) {
    const node = nodeById.get(hit.elementId);

    if (!node) {
      continue;
    }

    const dedupKey = `${hit.elementId}:${hit.sensitivityClass}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);

    const cls = hit.sensitivityClass;
    const count = (nextIndex.get(cls) ?? 0) + 1;
    nextIndex.set(cls, count);
    const token = `[REDACTED_${cls.toUpperCase().replace(/-/g, "_")}_${count}]`;

    const realValue = node.value ?? node.placeholder ?? node.ariaLabel;

    if (realValue != null) {
      redactionKey.set(token, realValue);
    }

    if (node.value != null) {
      node.value = token;
    }

    if (node.placeholder != null) {
      node.placeholder = token;
    }

    if (node.ariaLabel != null) {
      node.ariaLabel = token;
    }
  }

  return { redactedMap, redactionKey };
}

export function redact(
  canvas: HTMLCanvasElement,
  hits: RedactHit[],
  options: RedactOptions = {}
): HTMLCanvasElement {
  const {
    method = "black",
    padding = 4,
    blurRadius = 12,
    createCanvas = () => document.createElement("canvas")
  } = options;
  const copy = createCanvas();
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext("2d");

  if (!ctx) {
    throw new Error("2D canvas context unavailable");
  }

  ctx.drawImage(canvas, 0, 0);

  for (const hit of hits) {
    const { x, y, w, h } = hit.bbox;
    const px = x - padding;
    const py = y - padding;
    const pw = w + 2 * padding;
    const ph = h + 2 * padding;

    if (pw <= 0 || ph <= 0) {
      continue;
    }

    if (method === "blur") {
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, px, py, pw, ph, 6);
      ctx.clip();
      ctx.filter = `blur(${blurRadius}px)`;
      ctx.drawImage(canvas, 0, 0);
      ctx.restore();
    } else {
      ctx.fillStyle = "#000000";
      ctx.fillRect(px, py, pw, ph);
    }
  }

  return copy;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}