import { detectSensitiveDomElements, type ElementNode, type SensitiveHit } from "./dom-sensitivity.ts";
import { resolveTokens, createRedactionTracker } from "./redaction.ts";
import { createDeltaTracker, expandDeltaContext, assignStructuralIds, type DeltaTracker } from "./delta.ts";
import {
  extractStructuralMap,
  findElementById,
  hasFrameNodes,
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
import {
  appendAuditEntries,
  redactionAuditTexts,
  type AuditEventKind,
  type AuditLogEntry
} from "./audit-log.ts";
import {
  decideLocalAction,
  DEFAULT_TASK,
  type AgentAction,
  type AgentMode
} from "./local-heuristics.ts";

type AgentMessage = {
  type: "SECURELINK_ACTIVATE_AGENT";
  sessionId: string;
  screenshotBase64: string;
  task?: string;
  /**
   * "automatic" (default) runs the full server pipeline; "local-only" makes
   * zero network calls and uses deterministic local heuristics instead.
   */
  mode?: AgentMode;
};

type AgentStepPayload = {
  session_id: string;
  structural_map: ElementNode[];
  screenshot_base64: string;
  task: string;
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
      errors?: string[];
    }
  | {
      ok: false;
      title: string;
      error: string;
      timings?: PipelineTimings;
      errors?: string[];
    };

type PerfUpdateMessage = {
  type: "SECURELINK_PERF_UPDATE";
  sessionId: string;
  timings: PipelineTimings;
  server: ServerTimings | null;
  metrics: PipelineMetrics;
  errors?: string[];
};

type RedactDebugMessage = { type: "SECURELINK_REDACT_DEBUG" };

type RedactDebugResponse = {
  structuralMap: ElementNode[];
  domHits: SensitiveHit[];
  devicePixelRatio: number;
};

/**
 * Fires from the content script the instant an in-page confirmation dialog is
 * shown, so an open popup can switch its status to "waiting for approval"
 * instead of looking frozen mid-reasoning.
 */
export type ConfirmationPendingMessage = {
  type: "SECURELINK_CONFIRM_PENDING";
  detail: string;
};

const AGENT_STEP_URL = "http://localhost:8000/agent/step";

/** Abort the network round trip after this long (the server may be down). */
const AGENT_REQUEST_TIMEOUT_MS = 30_000;

console.info("SecureLink injected into:", document.title);

// ── Session pipeline state (Phase 2 delta sync) ─────────────────────────────

const state = {
  sessionId: null as string | null,
  step: 0,
  cachedMap: null as ElementNode[] | null,
  redactor: createRedactionTracker(),
  delta: null as DeltaTracker | null,
  observerAttached: false,
  /** True after we've seen any iframe; force full extraction per step. */
  hasFrames: false,
  /** Audit log buffer for the current session (flushed to storage + popup). */
  audit: [] as AuditLogEntry[],
  auditSeq: 0
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
  state.audit = [];
  state.auditSeq = 0;
}

/**
 * Append an audit entry to the current session's buffer. Entries are flushed to
 * `chrome.storage.session` (and mirrored to the popup) at the end of each step,
 * or sooner once the buffer grows past a small threshold.
 */
function recordAudit(kind: AuditEventKind, text: string): void {
  if (state.sessionId === null) {
    return;
  }
  state.audit.push({ seq: ++state.auditSeq, ts: Date.now(), kind, text });
  if (state.audit.length >= 25) {
    void flushAudit();
  }
}

async function flushAudit(): Promise<void> {
  if (state.sessionId === null || state.audit.length === 0) {
    return;
  }
  const entries = state.audit;
  state.audit = [];
  await appendAuditEntries(state.sessionId, entries);
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
 * always receives a complete, consistent map. Pages with iframes skip delta
 * sync entirely: the top-document observer cannot see inside frames, so full
 * extraction is the only correct choice there.
 */
function collectStructuralMap(): {
  map: ElementNode[];
  changedCount: number;
  deltaUsed: boolean;
  redactionIds: string[];
  /** Nodes that are candidates for sensitivity detection this step. */
  detectionNodes: ElementNode[];
  /** Why delta was not used, when it wasn't. */
  fullExtractionReason?: string;
} {
  ensureObserver();

  if (!state.cachedMap || state.sessionId === null || state.hasFrames) {
    // First capture of a session (or iframe pages): full extraction.
    const map = extractStructuralMap(document);
    // Our own synthetic-id assignment mutates the DOM; discard those mutations
    // so the first delta collection only reflects real page changes.
    state.delta?.collectChangedElements();

    state.cachedMap = map;
    state.hasFrames = hasFrameNodes(map);

    const redactionIds = map.map((node) => node.id);
    return {
      map,
      changedCount: map.length,
      deltaUsed: false,
      redactionIds,
      detectionNodes: map,
      fullExtractionReason: state.hasFrames
        ? "iframes present; container documents are not observable by the delta observer"
        : undefined
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

  // Newly mounted elements (React-style commits) carry no synthetic id yet —
  // assign one now (across the whole mounted subtree) so context expansion,
  // re-extraction and redaction can find them. Elements that are gone are
  // collected as removals for the merge.
  assignStructuralIds(document, changedElements);

  const removedIds = new Set(
    changedElements
      .filter((element) => !element.isConnected)
      .map((element) => element.getAttribute(STRUCTURAL_ID_ATTR))
      .filter((id): id is string => id !== null)
  );

  const deltaIds = expandDeltaContext(changedElements);
  const toProcess = new Set([...deltaIds, ...removedIds]);

  const updated: ElementNode[] = [];

  for (const id of toProcess) {
    const element = findElementById(document, id);

    if (element) {
      updated.push(toElementNode(document, element));
    }
  }

  const map = mergeDeltaNodes(state.cachedMap, updated, Array.from(removedIds));
  state.cachedMap = map;

  return {
    map,
    changedCount: toProcess.size,
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

function confirmIfNeeded(action: AgentAction, message: string): Promise<boolean> {
  if (action.requires_confirmation !== true) {
    return Promise.resolve(true);
  }

  return requestSensitiveConfirmation(message);
}

/**
 * Tell an open popup that the pipeline has paused on an in-page confirmation
 * dialog. Mirrors the audit-log broadcast pattern; safe when the popup is
 * closed or no listener is attached.
 */
async function reportConfirmationPending(detail: string): Promise<void> {
  try {
    const message: ConfirmationPendingMessage = {
      type: "SECURELINK_CONFIRM_PENDING",
      detail
    };
    await chrome.runtime.sendMessage(message);
  } catch {
    // Popup closed — the dialog in the page is the fallback indicator.
  }
}

/**
 * Clean in-page confirmation dialog (replaces the native `confirm()`). A small
 * centered card on a dimmed overlay with only two buttons, full keyboard
 * support, and immediate cleanup. Falls back to a native confirm if the page
 * DOM is unavailable.
 */
function requestSensitiveConfirmation(bodyText: string): Promise<boolean> {
  if (!document.body) {
    return Promise.resolve(window.confirm(bodyText));
  }

  const resolveRef: { current: ((proceed: boolean) => void) | null } = {
    current: null
  };
  const promise = new Promise<boolean>((resolve) => {
    resolveRef.current = resolve;
  });

  const overlay = document.createElement("div");
  const card = document.createElement("div");
  const title = document.createElement("div");
  const body = document.createElement("div");
  const actions = document.createElement("div");
  const cancel = document.createElement("button");
  const proceed = document.createElement("button");

  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(15,23,42,.45);" +
    "display:flex;align-items:center;justify-content:center;" +
    "z-index:2147483000;padding:24px;";
  card.style.cssText =
    "background:#ffffff;border-radius:12px;box-shadow:0 12px 40px rgba(15,23,42,.28);" +
    "max-width:380px;width:100%;padding:20px 22px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;";
  title.style.cssText =
    "font-size:15px;font-weight:700;color:#111827;margin-bottom:8px;";
  body.style.cssText =
    "font-size:13px;line-height:1.5;color:#374151;margin-bottom:18px;word-break:break-word;";
  actions.style.cssText =
    "display:flex;gap:10px;justify-content:flex-end;";
  cancel.style.cssText =
    "font:inherit;font-size:13px;font-weight:600;padding:7px 14px;border-radius:8px;" +
    "border:1px solid #d1d5db;background:#ffffff;color:#374151;cursor:pointer;";
  proceed.style.cssText =
    "font:inherit;font-size:13px;font-weight:600;padding:7px 14px;border-radius:8px;" +
    "border:1px solid #146ef5;background:#146ef5;color:#ffffff;cursor:pointer;";

  title.textContent = "SecureLink action";
  body.textContent = bodyText;
  cancel.textContent = "Cancel";
  proceed.textContent = "Proceed";

  actions.append(cancel, proceed);
  card.append(title, body, actions);
  overlay.append(card);
  document.body.appendChild(overlay);
  void reportConfirmationPending(bodyText);

  const resolve = (proceedValue: boolean): void => {
    overlay.remove();
    resolveRef.current?.(proceedValue);
    resolveRef.current = null;
  };

  cancel.addEventListener("click", () => resolve(false));
  proceed.addEventListener("click", () => resolve(true));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      resolve(false);
    }
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      resolve(false);
    }
  });
  overlay.tabIndex = -1;
  proceed.focus();

  return promise;
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

    const shouldProceed = await confirmIfNeeded(
      action,
      `SecureLink wants to click "${target.textContent?.trim() || action.target_id}". Proceed?`
    );
    if (!shouldProceed) {
      console.info("SecureLink click cancelled by user.");
      recordAudit("info", `Cancelled clicking "${target.textContent?.trim() || action.target_id}"`);
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
    recordAudit("action", `Clicked "${target.textContent?.trim() || action.target_id}" (#${action.target_id})`);
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
    const shouldProceed = await confirmIfNeeded(
      action,
      `SecureLink wants to type into "${action.target_id}". Proceed?`
    );
    if (!shouldProceed) {
      console.info("SecureLink type cancelled by user.");
      recordAudit("info", `Cancelled typing into "${action.target_id}"`);
      return;
    }

    setNativeValue(target, realValue);
    dispatchInput(target, realValue);
    console.info("SecureLink typed into:", target, JSON.stringify(realValue));
    recordAudit("action", `Typed into "${action.target_id}" (${String(realValue).length} characters, redacted token)`);
    return;
  }

  if (action.action === "scroll") {
    const shouldProceed = await confirmIfNeeded(action, `SecureLink wants to scroll the page. Proceed?`);
    if (!shouldProceed) {
      console.info("SecureLink scroll cancelled by user.");
      recordAudit("info", "Cancelled scrolling the page");
      return;
    }

    const amount =
      typeof action.amount === "number" ? action.amount
      : action.value === "up" ? -window.innerHeight * 0.8
      : action.value === "down" ? window.innerHeight * 0.8
      : window.innerHeight * 0.5;

    window.scrollBy({ top: amount, behavior: "smooth" });
    console.info("SecureLink scrolled window by:", amount);
    recordAudit("action", `Scrolled the page by ${Math.round(amount)}px`);
    return;
  }

  if (action.action === "navigate") {
    const destination = action.value || "/";
    const shouldProceed = await confirmIfNeeded(
      action,
      `SecureLink wants to navigate to "${destination}". Proceed?`
    );
    if (!shouldProceed) {
      console.info("SecureLink navigate cancelled by user.");
      recordAudit("info", `Cancelled navigating to "${destination}"`);
      return;
    }

    if (/^https?:\/\//i.test(destination)) {
      window.location.href = destination;
    } else {
      window.location.href = new URL(destination, window.location.href).href;
    }
    console.info("SecureLink navigating to:", destination);
    recordAudit("action", `Navigated to "${destination}"`);
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_REQUEST_TIMEOUT_MS);

  let response: Response;

  try {
    response = await fetch(AGENT_STEP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

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
        errors: message.errors ?? [],
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

        const isNewSession = state.sessionId !== message.sessionId;

        if (isNewSession) {
          resetSession(message.sessionId);
        }
        state.step += 1;

        const mode: AgentMode = message.mode ?? "automatic";
        recordAudit(
          "info",
          isNewSession
            ? `Session started in ${mode} mode.`
            : `Step ${state.step} (${mode} mode).`
        );

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
        const errors: string[] = [];

        const stage = async <T>(
          name: string,
          run: () => T | Promise<T>
        ): Promise<T | undefined> => {
          const stop = startTimer();
          try {
            return await run();
          } catch (error) {
            const message =
              error instanceof Error ? error.message : `Stage '${name}' failed`;
            errors.push(`${name}: ${message}`);
            console.error(`SecureLink stage '${name}' failed:`, error);
            return undefined;
          } finally {
            timings[name as keyof PipelineTimings] = stop();
          }
        };

        const metrics: PipelineMetrics = {
          changedElements: 0,
          totalElements: 0,
          deltaUsed: false,
          step: state.step,
          stage: "structuralMap"
        };

        // Stage: structural map (full on first step, delta afterwards).
        const collected = await stage("structuralMap", () => collectStructuralMap());

        if (!collected) {
          // The map is unusable — do not leak an unredacted/partial payload.
          await postPerfUpdate({
            type: "SECURELINK_PERF_UPDATE",
            sessionId: message.sessionId,
            timings: normaliseTimings(timings),
            server,
            metrics,
            errors
          });
          await flushAudit();
          sendResponse({
            ok: false,
            title: document.title,
            error: errors.join("; ") || "Failed to build the structural map.",
            timings: aggregate ?? normaliseTimings(timings),
            errors
          });
          return;
        }

        metrics.changedElements = collected.changedCount;
        metrics.totalElements = collected.map.length;
        metrics.deltaUsed = collected.deltaUsed;
        if (collected.fullExtractionReason) {
          metrics.fullExtractionReason = collected.fullExtractionReason;
        }

        // Stage: sensitive element detection (DOM). Delta steps only scan the
        // changed elements (plus siblings/parent) instead of the full map.
        await stage("sensitiveDetection", () => {
          detectSensitiveDomElements(collected.detectionNodes);
        });

        // Stage: redaction — tracker keeps tokens stable; delta steps only
        // re-tokenize the changed ids.
        await stage("redaction", () => {
          state.redactor.redactNodes(collected.map, collected.redactionIds);
        });

        for (const text of redactionAuditTexts(
          collected.map,
          collected.redactionIds
        )) {
          recordAudit("redaction", text);
        }

        // Stage: decide + execute the action.
        const localAction = mode === "local-only"
          ? await stage("actionExecution", () =>
              decideLocalAction(message.task ?? DEFAULT_TASK, collected.map)
            )
          : null;

        if (mode === "local-only") {
          if (!localAction || localAction.action === "none") {
            await flushAudit();
            await postPerfUpdate({
              type: "SECURELINK_PERF_UPDATE",
              sessionId: message.sessionId,
              timings: normaliseTimings(timings),
              server,
              metrics,
              errors
            });
            sendResponse({
              ok: false,
              title: document.title,
              error: localAction?.reasoning ?? "No actionable element found on the page.",
              timings: aggregate ?? normaliseTimings(timings),
              errors
            });
            return;
          }

          recordAudit("info", `Local-only decision: ${localAction.reasoning}`);
          const chosen = localAction;
          await stage("actionExecution", () =>
            executeAction(chosen, state.redactor.getRedactionKey())
          );

          aggregate = normaliseTimings(timings);
          logPerStage(timings, metrics);
          logPipelineTimings(timings, { server: null, metrics });

          await postPerfUpdate({
            type: "SECURELINK_PERF_UPDATE",
            sessionId: message.sessionId,
            timings: aggregate,
            server,
            metrics,
            errors
          });
          await flushAudit();
          sendResponse({
            ok: true,
            title: document.title,
            action: localAction,
            timings: aggregate,
            errors
          });
          return;
        }

        // Stage: network round trip (transport + server processing).
        const result = await stage("networkRoundTrip", () =>
          sendToAgent({
            session_id: message.sessionId,
            structural_map: collected.map,
            screenshot_base64: message.screenshotBase64,
            task: message.task ?? DEFAULT_TASK
          })
        );
        if (result) {
          server = result.timings ?? null;
        }

        if (!result) {
          // Server unreachable / timed out / rejected. Surface it, don't hang.
          const lastError = errors[errors.length - 1] ?? "Agent server did not respond";
          await postPerfUpdate({
            type: "SECURELINK_PERF_UPDATE",
            sessionId: message.sessionId,
            timings: normaliseTimings(timings),
            server,
            metrics,
            errors
          });
          await flushAudit();
          sendResponse({
            ok: false,
            title: document.title,
            error: lastError,
            timings: normaliseTimings(timings),
            errors
          });
          return;
        }

        // Stage: execute the returned action.
        await stage("actionExecution", async () => {
          if (result.action) {
            await executeAction(result.action, state.redactor.getRedactionKey());
          }
        });

        aggregate = normaliseTimings(timings);
        logPerStage(timings, metrics);
        logPipelineTimings(timings, { server, metrics });

        await postPerfUpdate({
          type: "SECURELINK_PERF_UPDATE",
          sessionId: message.sessionId,
          timings: aggregate,
          server,
          metrics,
          errors
        });
        await flushAudit();

        console.info(
          `SecureLink delta summary: ${metrics.changedElements} changed / ${metrics.totalElements} total ` +
            `(deltaUsed=${metrics.deltaUsed}, step=${metrics.step})`
        );

        if (errors.length > 0) {
          console.warn("SecureLink degraded with errors:", errors);
        }

        if (result.action) {
          sendResponse({
            ok: true,
            title: document.title,
            action: result.action,
            timings: aggregate,
            errors
          });
        } else {
          const messageText = result.message ?? "No actionable result from the agent.";
          sendResponse({
            ok: false,
            title: document.title,
            error: messageText,
            timings: aggregate,
            errors
          });
        }
      } catch (error) {
        const messageText =
          error instanceof Error && error.name === "AbortError"
            ? `Agent server did not respond within ${AGENT_REQUEST_TIMEOUT_MS / 1000}s`
            : error instanceof Error
              ? error.message
              : "Unknown agent activation error";

        console.error("SecureLink agent flow failed:", error);
        await flushAudit();
        sendResponse({ ok: false, title: document.title, error: messageText });
      }
    })();

    return true;
  }
);