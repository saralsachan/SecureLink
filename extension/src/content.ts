import {
  detectSensitiveDomElements,
  type BoundingBox,
  type ElementNode,
  type SensitiveHit
} from "./dom-sensitivity";
import { redactStructuralMap, resolveTokens } from "./redaction";

type AgentMessage = {
  type: "SECURELINK_ACTIVATE_AGENT";
  sessionId: string;
  screenshotBase64: string;
  task?: string;
};

type AgentStepPayload = {
  session_id: string;
  structural_map: ElementNode[];
  screenshot_base64: string;
  task: string;
};

type AgentAction = {
  action: "click" | "type" | "scroll" | "navigate";
  target_id?: string;
  value?: string | null;
  amount?: number;
  reasoning: string;
  requires_confirmation?: boolean;
};

type AgentActivationResponse =
  | {
      ok: true;
      title: string;
      action: AgentAction;
    }
  | {
      ok: false;
      title: string;
      error: string;
    };

const AGENT_STEP_URL = "http://localhost:8000/agent/step";
const STRUCTURAL_ID_ATTR = "data-agent-id";
const STRUCTURAL_ELEMENT_SELECTOR = [
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

console.info("SecureLink injected into:", document.title);

function getSyntheticId(element: HTMLElement): string {
  const existingId = element.getAttribute(STRUCTURAL_ID_ATTR);

  if (existingId) {
    return existingId;
  }

  let id = `el_${nextSyntheticElementId}`;

  while (document.querySelector(`[${STRUCTURAL_ID_ATTR}="${id}"]`)) {
    nextSyntheticElementId += 1;
    id = `el_${nextSyntheticElementId}`;
  }

  element.setAttribute(STRUCTURAL_ID_ATTR, id);
  nextSyntheticElementId += 1;
  return id;
}

function isVisibleInViewport(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && element.type === "hidden") {
    return false;
  }

  const style = window.getComputedStyle(element);

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

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

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

function getAriaLabel(element: HTMLElement): string | null {
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
    .map((id) => document.getElementById(id)?.textContent?.trim())
    .filter(Boolean)
    .join(" ");

  return label || null;
}

function toElementNode(element: HTMLElement): ElementNode {
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
    id: getSyntheticId(element),
    tag: element.tagName.toLowerCase(),
    role: inferRole(element),
    bbox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    },
    inputType: getInputType(element),
    ariaLabel: getAriaLabel(element),
    autocomplete: element.getAttribute("autocomplete"),
    placeholder: element.getAttribute("placeholder"),
    value
  };
}

function extractStructuralMap(): ElementNode[] {
  return Array.from(document.querySelectorAll<HTMLElement>(STRUCTURAL_ELEMENT_SELECTOR))
    .filter(isVisibleInViewport)
    .map(toElementNode);
}

async function sendToAgent(payload: AgentStepPayload): Promise<AgentAction> {
  console.info("SecureLink sending payload to agent:", payload);

  const response = await fetch(AGENT_STEP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Agent request failed with ${response.status}`);
  }

  const action = (await response.json()) as AgentAction;
  console.info("SecureLink received action:", action);
  return action;
}

function dispatchInput(target: HTMLElement, value: string): void {
  // Focus the field so the page treats the input as though the user typed it.
  target.focus();

  for (const char of value) {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: char,
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
    target.dispatchEvent(
      new KeyboardEvent("keypress", {
        key: char,
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
    target.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: char,
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
  }

  const inputEvent = new Event("input", { bubbles: true, cancelable: true });
  target.dispatchEvent(inputEvent);
  target.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
}

function setNativeValue(target: Element, value: string): void {
  const proto = (
    target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : target instanceof HTMLInputElement ? HTMLInputElement.prototype
    : HTMLSelectElement.prototype
  ) as HTMLInputElement;
  const valueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

  if (valueSetter) {
    valueSetter.call(target, value);
  } else {
    (target as HTMLInputElement).value = value;
  }

  target.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
}

function confirmIfNeeded(action: AgentAction, message: string): boolean {
  if (action.requires_confirmation !== true) {
    return true;
  }

  return window.confirm(message);
}

async function executeAction(
  action: AgentAction,
  redactionKey?: ReadonlyMap<string, string> | null
): Promise<void> {
  console.info("SecureLink executing action:", action);

  if (action.action === "click") {
    const target = document.querySelector<HTMLElement>(
      `[${STRUCTURAL_ID_ATTR}="${CSS.escape(action.target_id ?? "")}"]`
    );

    if (!target) {
      throw new Error(`No element found for target_id ${action.target_id}`);
    }

    const shouldProceed = confirmIfNeeded(
      action,
      `SecureLink wants to click "${target.textContent?.trim() || action.target_id}". Proceed?`
    );
    if (!shouldProceed) {
      console.info("SecureLink click cancelled by user.");
      return;
    }

    target.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
    console.info("SecureLink dispatched click on:", target);
    return;
  }

  if (action.action === "type") {
    const target = document.querySelector<HTMLElement>(
      `[${STRUCTURAL_ID_ATTR}="${CSS.escape(action.target_id ?? "")}"]`
    );

    if (!target) {
      throw new Error(`No element found for target_id ${action.target_id}`);
    }

    const rawValue = action.value ?? "";
    const realValue = resolveTokens(rawValue, redactionKey);
    const shouldProceed = confirmIfNeeded(
      action,
      `SecureLink wants to type into "${action.target_id}". Proceed?`
    );
    if (!shouldProceed) {
      console.info("SecureLink type cancelled by user.");
      return;
    }

    setNativeValue(target, realValue);
    dispatchInput(target, realValue);
    console.info("SecureLink typed into:", target, JSON.stringify(realValue));
    return;
  }

  if (action.action === "scroll") {
    const shouldProceed = confirmIfNeeded(
      action,
      `SecureLink wants to scroll the page. Proceed?`
    );
    if (!shouldProceed) {
      console.info("SecureLink scroll cancelled by user.");
      return;
    }

    const amount =
      typeof action.amount === "number" ? action.amount
      : action.value === "up" ? -window.innerHeight * 0.8
      : action.value === "down" ? window.innerHeight * 0.8
      : window.innerHeight * 0.5;

    window.scrollBy({ top: amount, behavior: "smooth" });
    console.info("SecureLink scrolled window by:", amount);
    return;
  }

  if (action.action === "navigate") {
    const destination = action.value || "/";
    const shouldProceed = confirmIfNeeded(
      action,
      `SecureLink wants to navigate to "${destination}". Proceed?`
    );
    if (!shouldProceed) {
      console.info("SecureLink navigate cancelled by user.");
      return;
    }

    if (/^https?:\/\//i.test(destination)) {
      window.location.href = destination;
    } else {
      window.location.href = new URL(destination, window.location.href).href;
    }
    console.info("SecureLink navigating to:", destination);
    return;
  }

  console.warn("SecureLink unknown action:", action.action);
}

type RedactDebugMessage = { type: "SECURELINK_REDACT_DEBUG" };

type RedactDebugResponse = {
  structuralMap: ElementNode[];
  domHits: SensitiveHit[];
  devicePixelRatio: number;
};

const secureLinkWindow = window as typeof window & {
  secureLink?: {
    extractStructuralMap: typeof extractStructuralMap;
    sendToAgent: typeof sendToAgent;
    executeAction: typeof executeAction;
  };
};

secureLinkWindow.secureLink = {
  extractStructuralMap,
  sendToAgent,
  executeAction
};

chrome.runtime.onMessage.addListener(
  (
    message: AgentMessage | RedactDebugMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: AgentActivationResponse | RedactDebugResponse) => void
  ) => {
    if (message.type === "SECURELINK_REDACT_DEBUG") {
      const structuralMap = extractStructuralMap();
      const domHits = detectSensitiveDomElements(structuralMap);

      sendResponse({
        structuralMap,
        domHits,
        devicePixelRatio: window.devicePixelRatio
      });
      return true;
    }

    if (message.type !== "SECURELINK_ACTIVATE_AGENT") {
      return false;
    }

    void (async () => {
      try {
        console.info("SecureLink popup connected on:", document.title);

        const structuralMap = extractStructuralMap();
        const domHits = detectSensitiveDomElements(structuralMap);
        const { redactedMap, redactionKey } = redactStructuralMap(structuralMap, domHits);

        const action = await sendToAgent({
          session_id: message.sessionId,
          structural_map: redactedMap,
          screenshot_base64: message.screenshotBase64,
          task: message.task ?? "Activate agent"
        });

        await executeAction(action, redactionKey);
        sendResponse({ ok: true, title: document.title, action });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown agent activation error";

        console.error("SecureLink agent flow failed:", error);
        sendResponse({ ok: false, title: document.title, error: message });
      }
    })();

    return true;
  }
);
