import type { BoundingBox, ElementNode, SensitiveHit } from "./dom-sensitivity";

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

const redactionKey = new Map<string, string>();
const nextIndex = new Map<string, number>();

export function getRedactionKey(): ReadonlyMap<string, string> {
  return redactionKey;
}

export function redactStructuralMap(
  map: ElementNode[],
  domHits: SensitiveHit[]
): { redactedMap: ElementNode[]; redactionKey: ReadonlyMap<string, string> } {
  redactionKey.clear();
  nextIndex.clear();

  const redactedMap = map.map((node) => ({ ...node }));
  const nodeById = new Map(redactedMap.map((n) => [n.id, n]));

  for (const hit of domHits) {
    const node = nodeById.get(hit.elementId);

    if (!node) {
      continue;
    }

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