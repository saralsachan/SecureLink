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
  "textarea"
].join(",");

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

/** Full structural map extraction for the given document. */
export function extractStructuralMap(doc: Document): ElementNode[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(STRUCTURAL_ELEMENT_SELECTOR))
    .filter((element) => isVisibleInViewport(doc, element))
    .map((element) => toElementNode(doc, element));
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
 * are dropped. Order of the cached map is preserved.
 */
export function mergeDeltaNodes(
  cached: readonly ElementNode[],
  updated: readonly ElementNode[],
  removedIds: readonly string[] = []
): ElementNode[] {
  const removed = new Set(removedIds);
  const byId = new Map(updated.map((node) => [node.id, node]));
  return cached.filter((node) => !removed.has(node.id)).map((node) => byId.get(node.id) ?? node);
}

export type { BoundingBox };