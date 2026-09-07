/**
 * Framework-free DOM → structural map extraction.
 *
 * Every function here is parameterized by a `Document` so the exact same code
 * path runs in the content script (browser) and in the Node/jsdom profiling
 * harness and tests. No chrome/DOM globals are assumed.
 */
import type { BoundingBox, ElementNode } from "./dom-sensitivity.ts";

export const STRUCTURAL_ID_ATTR = "data-agent-id";

export const STRUCTURAL_ELEMENT_SELECTOR = [
  "input",
  "button",
  "a[href]",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "select",
  "textarea",
  "iframe"
].join(",");

/** Maximum same-origin iframe nesting we descend into during extraction. */
export const MAX_FRAME_DEPTH = 4;

let nextSyntheticElementId = 0;

function getSyntheticId(doc: Document, element: HTMLElement): string {
  const existingId = element.getAttribute(STRUCTURAL_ID_ATTR);

  if (existingId) {
    return existingId;
  }

  let id = `el_${nextSyntheticElementId}`;

  while (doc.querySelector(`[${STRUCTURAL_ID_ATTR}="${id}"]`)) {
    nextSyntheticElementId += 1;
    id = `el_${nextSyntheticElementId}`;
  }

  element.setAttribute(STRUCTURAL_ID_ATTR, id);
  nextSyntheticElementId += 1;
  return id;
}

function isVisibleInViewport(doc: Document, element: HTMLElement): boolean {
  const view = doc.defaultView ?? window;

  if (element instanceof HTMLInputElement && element.type === "hidden") {
    return false;
  }

  const style = view.getComputedStyle(element);

  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse"
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const viewportWidth = view.innerWidth || doc.documentElement.clientWidth;
  const viewportHeight = view.innerHeight || doc.documentElement.clientHeight;

  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < viewportHeight &&
    rect.left < viewportWidth
  );
}

function inferRole(element: HTMLElement): string | null {
  const explicitRole = element.getAttribute("role");

  if (explicitRole) {
    return explicitRole;
  }

  const tag = element.tagName.toLowerCase();

  if (tag === "a") {
    return "link";
  }

  if (tag === "button") {
    return "button";
  }

  if (tag === "form") {
    return "form";
  }

  if (tag === "iframe") {
    return "iframe";
  }

  if (/^h[1-6]$/.test(tag)) {
    return "heading";
  }

  if (tag === "select") {
    return "combobox";
  }

  if (tag === "textarea") {
    return "textbox";
  }

  if (tag === "input") {
    const input = element as HTMLInputElement;
    return input.type === "checkbox" || input.type === "radio" ? input.type : "textbox";
  }

  return null;
}

function getInputType(element: HTMLElement): string | null {
  if (element instanceof HTMLInputElement) {
    return element.type;
  }

  if (element instanceof HTMLButtonElement) {
    return element.type || "button";
  }

  if (element instanceof HTMLTextAreaElement) {
    return "textarea";
  }

  if (element instanceof HTMLSelectElement) {
    return element.multiple ? "select-multiple" : "select-one";
  }

  return null;
}

function getAriaLabel(doc: Document, element: HTMLElement): string | null {
  const ariaLabel = element.getAttribute("aria-label")?.trim();

  if (ariaLabel) {
    return ariaLabel;
  }

  const labelledBy = element.getAttribute("aria-labelledby");

  if (!labelledBy) {
    return null;
  }

  const label = labelledBy
    .split(/\s+/)
    .map((id) => doc.getElementById(id)?.textContent?.trim())
    .filter(Boolean)
    .join(" ");

  return label || null;
}

/**
 * Serialize one element to a structural-map node. Values are read live from the
 * DOM, so a fresh call reflects the element's current state (used by delta sync
 * to re-read only changed elements).
 */
export function toElementNode(doc: Document, element: HTMLElement): ElementNode {
  const rect = element.getBoundingClientRect();

  let value: string | null = null;

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    value = element.value || null;
  }

  return {
    id: getSyntheticId(doc, element),
    tag: element.tagName.toLowerCase(),
    role: inferRole(element),
    bbox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    },
    inputType: getInputType(element),
    ariaLabel: getAriaLabel(doc, element),
    autocomplete: element.getAttribute("autocomplete"),
    placeholder: element.getAttribute("placeholder"),
    value
  };
}

/**
 * True when a merged map contains any iframe (or iframe-resident) node.
 * Content scripts use this to decide whether delta sync is safe: iframe
 * documents are not tracked by the top-document MutationObserver, so any map
 * that spans frames falls back to full extraction per step.
 */
export function hasFrameNodes(map: readonly ElementNode[]): boolean {
  return map.some((node) => node.tag === "iframe" || (node.frameDepth ?? 0) > 0);
}

/**
 * Full structural map extraction for the given document. Same-origin iframes
 * are traversed recursively (bounded by {@link MAX_FRAME_DEPTH}); inner
 * element bboxes are offset by their iframe chain so coordinates stay relative
 * to the top viewport (the screenshot). Cross-origin frames are recorded as
 * iframe nodes with `crossOrigin: true` — their contents are not inspectable
 * and are only covered by the screenshot-based visual path.
 */
export function extractStructuralMap(doc: Document): ElementNode[] {
  const visitedDocs = new WeakSet<Document>();
  const nodes: ElementNode[] = [];
  collectMapNodes(doc, visitedDocs, nodes, 0, 0, 0);
  return nodes;
}

function collectMapNodes(
  doc: Document,
  visitedDocs: WeakSet<Document>,
  out: ElementNode[],
  offsetX: number,
  offsetY: number,
  frameDepth: number
): void {
  if (frameDepth > MAX_FRAME_DEPTH || visitedDocs.has(doc)) {
    return;
  }
  visitedDocs.add(doc);

  for (const element of Array.from(
    doc.querySelectorAll<HTMLElement>(STRUCTURAL_ELEMENT_SELECTOR)
  )) {
    if (!isVisibleInViewport(doc, element)) {
      continue;
    }

    const node = toElementNode(doc, element);
    node.bbox.x += offsetX;
    node.bbox.y += offsetY;
    node.frameDepth = frameDepth;

    if (element.tagName.toLowerCase() === "iframe") {
      collectIframeContents(element as HTMLIFrameElement, node, visitedDocs, out);
      node.crossOrigin ??= false;
    }

    out.push(node);
  }
}

function collectIframeContents(
  iframe: HTMLIFrameElement,
  frameNode: ElementNode,
  visitedDocs: WeakSet<Document>,
  out: ElementNode[]
): void {
  let contentDoc: Document | null = null;

  try {
    contentDoc = iframe.contentDocument;
  } catch {
    // Cross-origin iframe: contents are not script-accessible.
    frameNode.crossOrigin = true;
    return;
  }

  if (!contentDoc) {
    // Same-origin but not loaded yet — nothing to collect this pass.
    return;
  }

  collectMapNodes(
    contentDoc,
    visitedDocs,
    out,
    frameNode.bbox.x,
    frameNode.bbox.y,
    (frameNode.frameDepth ?? 0) + 1
  );
}

/**
 * Locate a structural-map element by its synthetic id (used by action
 * execution and delta merge).
 */
export function findElementById(doc: Document, id: string): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`[${STRUCTURAL_ID_ATTR}="${CSS.escape(id)}"]`);
}

/**
 * Merge freshly re-extracted delta nodes into a cached full map (Phase 2).
 * Updated nodes replace their previous entries (matched by id); removed ids
 * are dropped; *new* ids (framework-mounted elements that were not in the
 * cached map) are appended so the map handed to the server stays complete.
 * Order of the cached map is preserved.
 */
export function mergeDeltaNodes(
  cached: readonly ElementNode[],
  updated: readonly ElementNode[],
  removedIds: readonly string[] = []
): ElementNode[] {
  const removed = new Set(removedIds);
  const byId = new Map(updated.map((node) => [node.id, node]));
  const cachedIds = new Set(cached.map((node) => node.id));
  const fresh = updated.filter((node) => !cachedIds.has(node.id) && !removed.has(node.id));

  return [
    ...cached.filter((node) => !removed.has(node.id)).map((node) => byId.get(node.id) ?? node),
    ...fresh
  ];
}

export type { BoundingBox };