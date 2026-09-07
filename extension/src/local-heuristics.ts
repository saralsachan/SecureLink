/**
 * Local-only agent mode.
 *
 * When the user toggles "Local-only mode" the extension makes zero network
 * calls. Instead of asking the server, it picks a deterministic next step from
 * the structural map using simple heuristics ("click the first submit button",
 * "navigate to the URL in the task", "scroll up/down", "fill the first empty
 * text field"). Everything here is pure so it can be unit-tested without a
 * browser or a server.
 */
import type { ElementNode } from "./dom-sensitivity.ts";

export type AgentMode = "automatic" | "local-only";

export type AgentAction = {
  action: "click" | "type" | "scroll" | "navigate" | "none";
  target_id?: string;
  value?: string | null;
  amount?: number;
  reasoning: string;
  requires_confirmation?: boolean;
};

export const DEFAULT_TASK = "Activate agent";

const SUBMIT_LABEL_HINTS = [
  "submit",
  "log in",
  "login",
  "sign in",
  "signin",
  "sign up",
  "go",
  "search",
  "continue",
  "get started",
  "send",
  "next",
  "save",
  "ok",
  "buy",
  "download",
  "register",
  "proceed"
];

function nodeLabel(node: ElementNode): string {
  return node.ariaLabel || node.placeholder || `#${node.id}`;
}

/**
 * Deterministically choose the submit-like control to click. Prefers a visible
 * button/input[type=submit] whose label hints at submission, falling back to
 * the first button or submit input in the map.
 */
export function pickSubmitElement(map: readonly ElementNode[]): ElementNode | null {
  for (const node of map) {
    if (node.tag !== "button" && node.inputType !== "submit") {
      continue;
    }

    const label = [node.value, node.ariaLabel, node.placeholder]
      .filter((part): part is string => Boolean(part))
      .join(" ")
      .toLowerCase();

    if (label && SUBMIT_LABEL_HINTS.some((hint) => label.includes(hint))) {
      return node;
    }
  }

  return (
    map.find(
      (node) => node.tag === "button" || node.inputType === "submit"
    ) ?? null
  );
}

/**
 * Decide the next action locally for *task* against *map*.
 *
 * Ordering is deliberate so the result is reproducible: navigate -> scroll ->
 * explicit type/fill -> submit/button/link click -> none. The default task
 * (`DEFAULT_TASK`) has no keywords and therefore clicks the first submit
 * button, exactly as specified.
 */
export function decideLocalAction(
  task: string,
  map: readonly ElementNode[]
): AgentAction {
  const text = (task ?? "").toLowerCase();

  // "go to <url>" / "open <url>" / "visit <url>". Navigation is page-level and
  // needs no map, so it is decided before the empty-map guard.
  const navigateMatch = text.match(
    /\b(?:go to|open|visit|navigate to|go)\s+((?:https?:\/\/)?[^\s"']+)/
  );
  if (navigateMatch && /(?:https?:\/\/)|(?:\.[a-z]{2,}(?:\/|$))/i.test(navigateMatch[1])) {
    const raw = navigateMatch[1];
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return {
      action: "navigate",
      value: url,
      reasoning: `local heuristic: navigate to "${url}"`,
      requires_confirmation: true
    };
  }

  if (map.length === 0) {
    return {
      action: "none",
      reasoning: "The page exposed no actionable elements."
    };
  }

  // "scroll up"/"scroll down".
  const scrollMatch = text.match(/\bscroll\s+(up|down)\b/);
  if (scrollMatch) {
    return {
      action: "scroll",
      value: scrollMatch[1],
      reasoning: `local heuristic: scroll ${scrollMatch[1]}`,
      requires_confirmation: false
    };
  }

  // "type <value>" / "fill <value>" / "enter <value>" / "search for <value>".
  const typeMatch = text.match(
    /\b(?:type|fill|enter|search(?: for)?)\s+"?([^"']+?)"?\s*$/
  );
  if (typeMatch) {
    const field = map.find(
      (node) =>
        ["text", "email", "search", "tel"].includes(node.inputType ?? "") &&
        (node.value ?? "") === ""
    );

    if (field) {
      const value = typeMatch[1].trim();
      return {
        action: "type",
        target_id: field.id,
        value,
        reasoning: `local heuristic: fill "${value}" into "${nodeLabel(field)}"`,
        requires_confirmation: true
      };
    }

    return {
      action: "none",
      reasoning: "No empty text field was found to type into."
    };
  }

  // Default: click the first submit-like control.
  const submit = pickSubmitElement(map);
  if (submit) {
    return {
      action: "click",
      target_id: submit.id,
      reasoning: `local heuristic: click "${nodeLabel(submit)}" (submit-like control)`,
      requires_confirmation: true
    };
  }

  const firstButton = map.find((node) => node.tag === "button");
  if (firstButton) {
    return {
      action: "click",
      target_id: firstButton.id,
      reasoning: `local heuristic: click "${nodeLabel(firstButton)}" (first button)`,
      requires_confirmation: true
    };
  }

  const firstLink = map.find((node) => node.tag === "a");
  if (firstLink) {
    return {
      action: "click",
      target_id: firstLink.id,
      reasoning: `local heuristic: click "${nodeLabel(firstLink)}" (first link)`,
      requires_confirmation: true
    };
  }

  return {
    action: "none",
    reasoning: "No button, link or submit control was found to act on."
  };
}