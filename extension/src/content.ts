import { detectSensitiveDomElements, type ElementNode, type SensitiveHit } from "./dom-sensitivity.ts";
import { resolveTokens, createRedactionTracker } from "./redaction.ts";
import { createDeltaTracker, expandDeltaContext, type DeltaTracker } from "./delta.ts";
import {
  extractStructuralMap,
  findElementById,
  mergeDeltaNodes,
  STRUCTURAL_ID_ATTR,
  toElementNode
} from "./dom-map.ts";
import {
  logPerStage,
  logPipelineTimings,
  normaliseTimings,
  startTimer,
  type PipelineMetrics,
  type PipelineTimings,
  type ServerTimings
} from "./pipeline-timing.ts";

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

type AgentStepResult = {
  ok: boolean;
  action?: AgentAction | null;
  step?: number;
  message?: string;
  timings?: ServerTimings | null;
};

type AgentActivationResponse =
  | {
      ok: true;
      title: string;
      action: AgentAction;
      timings?: PipelineTimings;
    }
  | {
      ok: false;
      title: string;
      error: string;
      timings?: PipelineTimings;
    };

type PerfUpdateMessage = {
  type: "SECURELINK_PERF_UPDATE";
  sessionId: string;
  timings: PipelineTimings;
  server: ServerTimings | null;
  metrics: PipelineMetrics;
};

type RedactDebugMessage = { type: "SECURELINK_REDACT_DEBUG" };

type RedactDebugResponse = {
  structuralMap: ElementNode[];
  domHits: SensitiveHit[];
  devicePixelRatio: number;
};

const AGENT_STEP_URL = "http://localhost:8000/agent/step";

console.info("SecureLink injected into:", document.title);

// ── Session pipeline state (Phase 2 delta sync) ─────────────────────────────

const state = {
  sessionId: null as string | null,
  step: 0,
  cachedMap: null as ElementNode[] | null,
  redactor: createRedactionTracker(),
  delta: null as DeltaTracker | null,
  observerAttached: false
};

async function readPopupStageTimings(sessionId: string): Promise<{
  capture: number;
  vitInference: number;
  verify: number;
}> {
  try {
    const key = `securelink:perf:${sessionId}`;
    const stored = await chrome.storage.session.get(key);
    const value = stored?.[key] as
      | { capture?: number; vitInference?: number; verify?: number }
      | undefined;
    return {
      capture: value?.capture ?? 0,
      vitInference: value?.vitInference ?? 0,
      verify: value?.verify ?? 0
    };
  } catch {
    return { capture: 0, vitInference: 0, verify: 0 };
  }
}

function resetSession(sessionId: string): void {
  state.sessionId = sessionId;
  state.step = 0;
  state.cachedMap = null;
  state.redactor = createRedactionTracker();
}

function ensureObserver(): void {
  if (state.observerAttached) {
    return;
  }
  state.delta = createDeltaTracker();
  state.delta.attach(document);
  state.observerAttached = true;
}

/**
 * Build the structural map for this step. First capture in a session does a
 * full extraction; later steps re-extract only mutated elements (plus
 * parent/siblings) and merge the delta into the cached full map, so the server
 * always receives a complete, consistent map.
 */
function collectStructuralMap(): {
  map: ElementNode[];
  changedCount: number;
  deltaUsed: boolean;
  redactionIds: string[];
  /** Nodes that are candidates for sensitivity detection this step. */
  detectionNodes: ElementNode[];
} {
  ensureObserver();

  if (!state.cachedMap || state.sessionId === null) {
    // First capture of a session: full extraction.
    const map = extractStructuralMap(document);
    // Our own synthetic-id assignment mutates the DOM; discard those mutations
    // so the first delta collection only reflects real page changes.
    state.delta?.collectChangedElements();

    state.cachedMap = map;
    const redactionIds = map.map((node) => node.id);
    return {
      map,
      changedCount: map.length,
      deltaUsed: false,
      redactionIds,
      detectionNodes: map
    };
  }

  const changedElements = state.delta?.collectChangedElements() ?? [];

  if (changedElements.length === 0) {
    // Nothing mutated since the last capture: reuse the cached map untouched.
    return {
      map: state.cachedMap,
      changedCount: 0,
      deltaUsed: true,
      redactionIds: [],
      detectionNodes: []
    };
  }

  const deltaIds = expandDeltaContext(changedElements);

  const updated: ElementNode[] = [];
  const removedIds: string[] = [];

  for (const id of deltaIds) {
    const element = findElementById(document, id);

    if (!element) {
      removedIds.push(id);
    } else {
      updated.push(toElementNode(document, element));
    }
  }

  const map = mergeDeltaNodes(state.cachedMap, updated, removedIds);
  state.cachedMap = map;

  return {
    map,
    changedCount: deltaIds.length,
    deltaUsed: true,
    redactionIds: updated.map((node) => node.id),
    detectionNodes: updated
  };
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
    const shouldProceed = confirmIfNeeded(action, `SecureLink wants to scroll the page. Proceed?`);
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

async function sendToAgent(payload: AgentStepPayload): Promise<AgentStepResult> {
  console.info("SecureLink sending payload to agent:", {
    session_id: payload.session_id,
    structural_map_count: payload.structural_map.length,
    task: payload.task
  });

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

  const result = (await response.json()) as AgentStepResult & { action?: AgentAction | null };
  console.info("SecureLink received action:", result.action ?? result.message);
  return result;
}

async function postPerfUpdate(message: PerfUpdateMessage): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Popup may be closed; the update is best-effort for the live overlay.
  }

  // Persist the last per-step breakdown so the overlay can replay it when the
  // popup is reopened (chrome.storage.session is cleared when the browser
  // session ends, so nothing sensitive lingers).
  try {
    const key = `securelink:perf:${message.sessionId}`;
    await chrome.storage.session.set({
      [key]: {
        timings: message.timings,
        server: message.server,
        metrics: message.metrics,
        ts: Date.now()
      }
    });
  } catch {
    // Best-effort replay cache.
  }
}

const secureLinkWindow = window as typeof window & {
  secureLink?: {
    extractStructuralMap: () => ElementNode[];
    sendToAgent: typeof sendToAgent;
    executeAction: typeof executeAction;
  };
};

secureLinkWindow.secureLink = {
  extractStructuralMap: () => extractStructuralMap(document),
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
      const structuralMap = extractStructuralMap(document);
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

        if (state.sessionId !== message.sessionId) {
          resetSession(message.sessionId);
        }
        state.step += 1;

        const popupTimings = await readPopupStageTimings(message.sessionId);

        const timings: PipelineTimings = {
          capture: popupTimings.capture,
          structuralMap: 0,
          vitInference: popupTimings.vitInference,
          sensitiveDetection: 0,
          redaction: 0,
          verify: popupTimings.verify,
          networkRoundTrip: 0,
          actionExecution: 0,
          total: 0
        };

        let server: ServerTimings | null = null;
        let aggregate: PipelineTimings | null = null;

        // Stage: structural map (full on first step, delta afterwards).
        let stop = startTimer();
        const collected = collectStructuralMap();
        timings.structuralMap = stop();

        const metrics: PipelineMetrics = {
          changedElements: collected.changedCount,
          totalElements: collected.map.length,
          deltaUsed: collected.deltaUsed,
          step: state.step,
          stage: "structuralMap"
        };

        // Stage: sensitive element detection (DOM). Delta steps only scan the
        // changed elements (plus siblings/parent) instead of the full map.
        stop = startTimer();
        const domHits = detectSensitiveDomElements(collected.detectionNodes);
        timings.sensitiveDetection = stop();

        // Stage: redaction — tracker keeps tokens stable; delta steps only
        // re-tokenize the changed ids.
        stop = startTimer();
        state.redactor.redactNodes(collected.map, collected.redactionIds);
        timings.redaction = stop();

        // Stage: network round trip (transport + server processing).
        stop = startTimer();
        const result = await sendToAgent({
          session_id: message.sessionId,
          structural_map: collected.map,
          screenshot_base64: message.screenshotBase64,
          task: message.task ?? "Activate agent"
        });
        timings.networkRoundTrip = stop();
        server = result.timings ?? null;

        // Stage: execute the returned action.
        stop = startTimer();
        if (result.action) {
          await executeAction(result.action, state.redactor.getRedactionKey());
        }
        timings.actionExecution = stop();

        aggregate = normaliseTimings(timings);
        logPerStage(timings, metrics);
        logPipelineTimings(timings, { server, metrics });

        await postPerfUpdate({
          type: "SECURELINK_PERF_UPDATE",
          sessionId: message.sessionId,
          timings: aggregate,
          server,
          metrics
        });

        console.info(
          `SecureLink delta summary: ${metrics.changedElements} changed / ${metrics.totalElements} total ` +
            `(deltaUsed=${metrics.deltaUsed}, step=${metrics.step})`
        );

        if (result.action) {
          sendResponse({ ok: true, title: document.title, action: result.action, timings: aggregate });
        } else {
          const messageText = result.message ?? "No actionable result from the agent.";
          sendResponse({ ok: false, title: document.title, error: messageText, timings: aggregate });
        }
      } catch (error) {
        const messageText =
          error instanceof Error ? error.message : "Unknown agent activation error";

        console.error("SecureLink agent flow failed:", error);
        sendResponse({ ok: false, title: document.title, error: messageText });
      }
    })();

    return true;
  }
);