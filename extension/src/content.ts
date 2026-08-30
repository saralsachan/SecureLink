type AgentMessage = {
  type: "SECURELINK_ACTIVATE_AGENT";
  task?: string;
};

type BoundingBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type ElementNode = {
  id: string;
  tag: string;
  role: string | null;
  bbox: BoundingBox;
  inputType: string | null;
  ariaLabel: string | null;
};

type AgentStepPayload = {
  structural_map: ElementNode[];
  screenshot_base64: string;
  task: string;
};

type AgentAction =
  | {
      action: "click";
      target_id: string;
      reasoning: string;
    }
  | {
      action: "scroll";
      amount: number;
      reasoning: string;
      target_id?: string;
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
    ariaLabel: getAriaLabel(element)
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

function executeAction(action: AgentAction): void {
  console.info("SecureLink executing action:", action);

  if (action.action === "click") {
    const target = document.querySelector<HTMLElement>(
      `[${STRUCTURAL_ID_ATTR}="${CSS.escape(action.target_id)}"]`
    );

    if (!target) {
      throw new Error(`No element found for target_id ${action.target_id}`);
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

  if (action.action === "scroll") {
    window.scrollBy({
      top: action.amount,
      behavior: "smooth"
    });
    console.info("SecureLink scrolled window by:", action.amount);
  }
}

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
    message: AgentMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: AgentActivationResponse) => void
  ) => {
    if (message.type !== "SECURELINK_ACTIVATE_AGENT") {
      return false;
    }

    void (async () => {
      try {
        console.info("SecureLink popup connected on:", document.title);

        const structuralMap = extractStructuralMap();
        console.info("SecureLink extracted structural map:", structuralMap);

        const action = await sendToAgent({
          structural_map: structuralMap,
          screenshot_base64: "",
          task: message.task ?? "Activate agent"
        });

        executeAction(action);
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
