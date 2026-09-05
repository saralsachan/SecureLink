/**
 * Phase 2 — delta-based state sync.
 *
 * Watches a document for DOM mutations (attribute changes, added/removed
 * nodes, characterData on text) *and* for `input`/`change` events (native
 * typing sets `element.value` as a property, which MutationObserver cannot
 * see). The coalesced set of changed elements lets subsequent agent steps
 * re-extract only the changed elements (plus parent/siblings for context)
 * instead of re-scanning the whole document.
 */
import { STRUCTURAL_ELEMENT_SELECTOR } from "./dom-map.ts";

export const DELTA_MAX_TRACKED_ELEMENTS = 1000;

const ATTRIBUTE_FILTER = [
  "data-agent-id",
  "value",
  "placeholder",
  "aria-label",
  "aria-labelledby",
  "role",
  "autocomplete",
  "type",
  "disabled"
];

export type DeltaSummary = {
  /** Structural-map ids that need re-extraction this step. */
  changedIds: string[];
  /** Number of raw changed elements observed (before context expansion). */
  changedCount: number;
  /** Total elements in the merged full map. */
  totalCount: number;
};

export type DeltaTracker = {
  /** Start observing the document (idempotent). */
  attach(doc: Document): void;
  /** Stop observing and drop input listeners. */
  detach(): void;
  /** Whether any mutations/events have been recorded since last reset. */
  readonly hasChanges: boolean;
  /**
   * Return the current changed elements and clear the buffer. The caller owns
   * mapping them to ids / context.
   */
  collectChangedElements(): HTMLElement[];
};

export function createDeltaTracker(): DeltaTracker {
  let doc: Document | null = null;
  let observer: MutationObserver | null = null;
  let onInput: ((event: Event) => void) | null = null;

  const changed = new Set<HTMLElement>();

  function remember(element: Element | null): void {
    if (!element || !(element instanceof HTMLElement)) {
      return;
    }
    if (changed.size >= DELTA_MAX_TRACKED_ELEMENTS) {
      return; // bounded; caller can fall back to a full scan
    }
    changed.add(element);
  }

  const handleMutations = (records: MutationRecord[]): void => {
    for (const mutation of records) {
      if (mutation.type === "attributes") {
        remember(mutation.target as Element);
        continue;
      }
      if (mutation.type === "characterData") {
        remember(mutation.target.parentElement);
        continue;
      }
      // childList: added/removed nodes → remember the node + its parent.
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) {
          remember(node);
        }
        remember(node.parentElement);
      }
      for (const node of mutation.removedNodes) {
        if (node instanceof HTMLElement) {
          remember(node);
        }
        remember(mutation.target as Element);
      }
    }
  };

  const handleInput = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLElement) {
      remember(target);
    }
  };

  function detachInternal(): void {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (doc && onInput) {
      doc.removeEventListener("input", onInput, true);
      doc.removeEventListener("change", onInput, true);
    }
    onInput = null;
  }

  return {
    attach(currentDoc: Document): void {
      if (doc === currentDoc && observer) {
        return;
      }
      doc = currentDoc;
      detachInternal();
      observer = new MutationObserver(handleMutations);
      observer.observe(currentDoc.documentElement, {
        attributes: true,
        attributeFilter: ATTRIBUTE_FILTER,
        childList: true,
        characterData: true,
        subtree: true
      });
      onInput = handleInput;
      currentDoc.addEventListener("input", onInput, true);
      currentDoc.addEventListener("change", onInput, true);
    },
    detach(): void {
      detachInternal();
      changed.clear();
      doc = null;
    },
    get hasChanges(): boolean {
      return changed.size > 0;
    },
    collectChangedElements(): HTMLElement[] {
      const elements = Array.from(changed);
      changed.clear();
      return elements;
    }
  };
}

/**
 * Expand *changed* elements to include their immediate parent and siblings for
 * context, restricted to elements that are currently in the structural map.
 * Returns unique element ids.
 */
export function expandDeltaContext(
  changedElements: readonly HTMLElement[]
): string[] {
  const expanded = new Set<HTMLElement>();

  for (const element of changedElements) {
    if (element.isConnected) {
      expanded.add(element);
    } else {
      // Removed from the DOM: keep its parent as context so the merge step can
      // drop the stale entry.
      if (element.parentElement) {
        expanded.add(element.parentElement);
      }
      continue;
    }

    const parent = element.parentElement;
    if (parent) {
      expanded.add(parent);
      for (const sibling of parent.children) {
        if (sibling instanceof HTMLElement) {
          expanded.add(sibling);
        }
      }
    }
  }

  const ids: string[] = [];
  for (const element of expanded) {
    const id = element.getAttribute("data-agent-id");
    if (id && element.matches(STRUCTURAL_ELEMENT_SELECTOR)) {
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}