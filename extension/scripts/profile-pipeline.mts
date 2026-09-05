/**
 * Profiling harness for the SecureLink agent pipeline (Phase 1).
 *
 * Loads the real multi-field test form into jsdom, runs the actual DOM pipeline
 * modules (structural-map extraction, sensitivity detection, redaction, delta
 * tracking) plus REAL network round trips against the FastAPI server (run with
 * a deterministic scripted backend so server VLM/grounding/firewall timings are
 * genuine wall-clock measurements), and executes the returned actions.
 *
 * Browser-only stages (screenshot capture, local ViT inference, OCR
 * self-verification) cannot run in Node — they are measured in the real popup
 * and shown as labeled proxies here (capture = real PNG encode via
 * @napi-rs/canvas; vitInference/verify = 0, browser-only).
 *
 * Usage:
 *   node --disable-warning=ExperimentalWarning scripts/profile-pipeline.mts
 *
 * Runs a delta-synced session (Phase 2 off/on) against the same form and prints
 * a before/after comparison per stage. Requires the inference-server venv.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { createCanvas } from "@napi-rs/canvas";
import {
  extractStructuralMap,
  findElementById,
  mergeDeltaNodes,
  toElementNode,
  STRUCTURAL_ID_ATTR
} from "../src/dom-map.ts";
import { createDeltaTracker, expandDeltaContext, type DeltaTracker } from "../src/delta.ts";
import { createRedactionTracker } from "../src/redaction.ts";
import { detectSensitiveDomElements, type ElementNode } from "../src/dom-sensitivity.ts";
import {
  logPerStage,
  logPipelineTimings,
  normaliseTimings,
  startTimer,
  type PipelineMetrics,
  type PipelineTimings,
  type ServerTimings
} from "../src/pipeline-timing.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const SERVER_URL = "http://127.0.0.1:8011";

// ── Profile server lifecycle ────────────────────────────────────────────────

function startProfileServer(): ReturnType<typeof spawn> {
  const python = path.join(
    REPO_ROOT, "inference-server", ".venv", "Scripts", "python.exe"
  );
  const child = spawn(
    python,
    ["-m", "tools.profile_server", "--port", "8011"],
    {
      cwd: path.join(REPO_ROOT, "inference-server"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PROFILE_PORT: "8011" }
    }
  );
  return child;
}

async function waitForHealth(child, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${SERVER_URL}/health`);
      if (resp.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const stderrTail = (child.stderr?.read() ?? "").toString();
  throw new Error(`profile server did not become healthy.\n${stderrTail}`);
}

async function resetProfileBackend(): Promise<void> {
  const resp = await fetch(`${SERVER_URL}/__profile/reset`, { method: "POST" });
  if (!resp.ok) {
    throw new Error(`reset failed: ${resp.status}`);
  }
}

// ── jsdom page setup ─────────────────────────────────────────────────────────

async function loadTestPage(): Promise<{ doc: Document; window: typeof globalThis & {} }> {
  const html = await readFile(path.join(SCRIPT_DIR, "..", "test.html"), "utf8");
  const silentConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    url: "http://localhost/test.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: silentConsole
  });

  // Expose jsdom's DOM classes as Node globals so the pipeline modules (which
  // reference bare `HTMLElement`, `MutationObserver`, …) behave identically.
  for (const name of [
    "HTMLElement", "Element", "Node", "Document",
    "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
    "HTMLButtonElement", "HTMLFormElement", "HTMLAnchorElement",
    "MutationObserver", "Event", "MouseEvent", "KeyboardEvent"
  ]) {
    globalThis[name] = dom.window[name];
  }

  // jsdom has no CSSOM: polyfill CSS.escape (ids here are simple `el_N`).
  if (!dom.window.CSS) {
    dom.window.CSS = {} as typeof CSS;
  }
  dom.window.CSS.escape = (value: string) =>
    String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  globalThis.CSS = dom.window.CSS;

  // jsdom has no layout: give every element a real box so visibility checks
  // behave like a rendered page. `.hidden` / `.offscreen` elements stay 0x0,
  // matching the real browser map of this test page (5 visible elements).
  dom.window.HTMLElement.prototype.getBoundingClientRect = function (this: Element) {
    const cls = String(this.className ?? "");
    if (/hidden|offscreen/.test(cls)) {
      return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } as DOMRect;
    }
    return {
      x: 40, y: 40, width: 180, height: 36, left: 40, top: 40, right: 220, bottom: 76
    } as DOMRect;
  };

  return { doc: dom.window.document, window: dom.window };
}

// ── Stage proxies (browser-only stages) ──────────────────────────────────────

function captureProxy(): string {
  const canvas = createCanvas(1280, 800);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 1280, 800);
  ctx.fillStyle = "#e2e8f0";
  for (const y of [120, 260, 400]) {
    ctx.fillRect(220, y, 280, 44);
  }
  ctx.fillStyle = "#cbd5e1";
  ctx.fillRect(220, 560, 280, 44);
  return canvas.toBuffer("image/png").toString("base64");
}

const captureMs = (() => {
  const stop = startTimer();
  captureProxy();
  return stop();
})();

// ── Session driver (mirrors content.ts) ─────────────────────────────────────

type Collected = {
  map: ElementNode[];
  changedCount: number;
  deltaUsed: boolean;
  redactionIds: string[];
  detectionNodes: ElementNode[];
};

type SessionState = {
  cachedMap: ElementNode[] | null;
  redactor: ReturnType<typeof createRedactionTracker>;
  delta: DeltaTracker | null;
  observerAttached: boolean;
};

function makeSessionState(): SessionState {
  const state: SessionState = {
    cachedMap: null,
    redactor: createRedactionTracker(),
    delta: null,
    observerAttached: false
  };
  return state;
}

function collectStructuralMap(doc: Document, state: SessionState, forceFull: boolean): Collected {
  if (!state.observerAttached) {
    state.delta = createDeltaTracker();
    state.delta.attach(doc);
    state.observerAttached = true;
  }

  if (forceFull || !state.cachedMap) {
    const map = extractStructuralMap(doc);
    state.delta?.collectChangedElements();
    state.cachedMap = map;
    const redactionIds = map.map((node) => node.id);
    return { map, changedCount: map.length, deltaUsed: !forceFull && state.cachedMap !== null, redactionIds, detectionNodes: map };
  }

  const changedElements = state.delta?.collectChangedElements() ?? [];
  if (changedElements.length === 0) {
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
    const element = findElementById(doc, id);
    if (!element) {
      removedIds.push(id);
    } else {
      updated.push(toElementNode(doc, element));
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

function setNativeValue(doc: Document, target: Element, value: string): void {
  const win = doc.defaultView!;
  const proto = (
    target instanceof win.HTMLTextAreaElement
      ? win.HTMLTextAreaElement.prototype
      : target instanceof win.HTMLInputElement
        ? win.HTMLInputElement.prototype
        : win.HTMLSelectElement.prototype
  ) as HTMLInputElement;
  const valueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (valueSetter) {
    valueSetter.call(target, value);
  } else {
    (target as HTMLInputElement).value = value;
  }
  target.dispatchEvent(new win.Event("input", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new win.Event("change", { bubbles: true, cancelable: true }));
}

function executeAction(doc: Document, action: Record<string, unknown>): void {
  const win = doc.defaultView!;
  const target = doc.querySelector<HTMLElement>(
    `[${STRUCTURAL_ID_ATTR}="${String(action.target_id ?? "")}"]`
  );
  if (!target) {
    throw new Error(`No element found for target_id ${action.target_id}`);
  }

  if (action.action === "click") {
    target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    return;
  }

  if (action.action === "type") {
    setNativeValue(doc, target, String(action.value ?? ""));
    return;
  }
}

type ServerTimingsRaw = {
  firewall_ms?: number;
  vlm_ms?: number;
  grounding_ms?: number;
  total_ms?: number;
};

function parseServerTimings(raw: ServerTimingsRaw | null | undefined): ServerTimings | null {
  if (!raw) {
    return null;
  }
  return {
    firewallMs: raw.firewall_ms ?? 0,
    vlmMs: raw.vlm_ms ?? 0,
    groundingMs: raw.grounding_ms ?? 0,
    totalMs: raw.total_ms ?? 0
  };
}

async function runSession(
  doc: Document,
  sessionId: string,
  forceFull: boolean,
  screenshotB64: string
): Promise<Array<{ timings: PipelineTimings; server: ServerTimings | null; metrics: PipelineMetrics }>> {
  const state = makeSessionState();
  const steps: Array<{ timings: PipelineTimings; server: ServerTimings | null; metrics: PipelineMetrics }> = [];

  const taskSequence = [
    "Fill the signup form name field",
    "Fill the signup form email field",
    "Submit the signup form"
  ];

  for (let step = 1; step <= taskSequence.length; step += 1) {
    const timings: PipelineTimings = {
      capture: captureMs,
      structuralMap: 0,
      vitInference: 0,
      sensitiveDetection: 0,
      redaction: 0,
      verify: 0,
      networkRoundTrip: 0,
      actionExecution: 0,
      total: 0
    };

    let stop = startTimer();
    const collected = collectStructuralMap(doc, state, forceFull);
    timings.structuralMap = stop();

    const metrics: PipelineMetrics = {
      changedElements: collected.changedCount,
      totalElements: collected.map.length,
      deltaUsed: collected.deltaUsed,
      step,
      stage: "structuralMap"
    };

    stop = startTimer();
    void detectSensitiveDomElements(collected.detectionNodes);
    timings.sensitiveDetection = stop();

    stop = startTimer();
    state.redactor.redactNodes(collected.map, collected.redactionIds);
    timings.redaction = stop();

    stop = startTimer();
    const resp = await fetch(`${SERVER_URL}/agent/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        structural_map: collected.map,
        screenshot_base64: screenshotB64,
        task: taskSequence[step - 1]
      })
    });
    if (!resp.ok) {
      throw new Error(`agent/step failed ${resp.status}: ${await resp.text()}`);
    }
    const result = (await resp.json()) as Record<string, unknown> & {
      timings?: ServerTimingsRaw;
    };
    timings.networkRoundTrip = stop();
    const server = parseServerTimings(result.timings);

    stop = startTimer();
    executeAction(doc, (result.action ?? {}) as Record<string, unknown>);
    timings.actionExecution = stop();

    const aggregate = normaliseTimings(timings);
    logPerStage(timings, metrics);
    logPipelineTimings(timings, { server, metrics });

    steps.push({ timings: aggregate, server, metrics });
  }

  return steps;
}

function meanMs(values: Array<{ timings: PipelineTimings }>, key: keyof PipelineTimings): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v.timings[key], 0) / values.length;
}

function formatTable(delta: Array<{ timings: PipelineTimings }>, full: Array<{ timings: PipelineTimings }>): void {
  const rows: Array<{ stage: string; full: number; delta: number; saved: number }> = [];
  for (const key of [
    "capture", "structuralMap", "vitInference", "sensitiveDetection",
    "redaction", "verify", "networkRoundTrip", "actionExecution"
  ] as const) {
    const fullMs = meanMs(full, key);
    const deltaMs = meanMs(delta, key);
    rows.push({ stage: key, full: fullMs, delta: deltaMs, saved: fullMs - deltaMs });
  }

  console.log("\n── Before/after per stage (mean ms / step) ──");
  console.log("stage                 full          delta         saved ms");
  for (const row of rows) {
    const saved = row.saved > 0.05 ? `-${row.saved.toFixed(1)}` : row.saved < -0.05 ? `+${Math.abs(row.saved).toFixed(1)}` : "±0";
    console.log(
      `${row.stage.padEnd(21)} ${row.full.toFixed(1).padStart(9)}   ${row.delta.toFixed(1).padStart(9)}   ${saved.padStart(9)} ms`
    );
  }

  const fullTotal = full.reduce((s, v) => s + v.timings.total, 0) / full.length;
  const deltaTotal = delta.reduce((s, v) => s + v.timings.total, 0) / delta.length;
  console.log(
    `\nEnd-to-end total (mean): ${fullTotal.toFixed(1)} ms  →  ${deltaTotal.toFixed(1)} ms  (saved ${(fullTotal - deltaTotal).toFixed(1)} ms, ${(100 * (fullTotal - deltaTotal) / fullTotal).toFixed(1)}%)`
  );

  const top = [...rows].sort((a, b) => b.delta - a.delta).slice(0, 3);
  console.log("\nTop 3 slowest stages (delta run, from real data):");
  for (const { stage, delta } of top) {
    console.log(`  ${stage.padEnd(21)} ${delta.toFixed(1)} ms`);
  }
  console.log("\nNOTE: vitInference + verify are browser-only stages; shown as 0 (proxies here).");
}

// ── Entry ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { doc } = await loadTestPage();
  const screenshotB64 = captureProxy();
  console.log(`[profile] capture proxy: ${captureMs.toFixed(1)} ms (real PNG encode, @napi-rs/canvas)`);
  console.log(`[profile] structural map size: ${extractStructuralMap(doc).length} elements`);

  const server = startProfileServer();
  try {
    await waitForHealth(server);
    console.log("[profile] profile server healthy at", SERVER_URL);

    console.log("\n== Phase 2 OFF (baseline: full extraction every step) ==");
    await resetProfileBackend();
    const fullSteps = await runSession(doc, "prof-full", true, screenshotB64);

    console.log("\n== Phase 2 ON (delta sync) ==");
    await resetProfileBackend();
    const deltaSteps = await runSession(doc, "prof-delta", false, screenshotB64);

    // ── Phase 2 acceptance: type a single character → only that field re-processes ──
    const state = makeSessionState();
    const emailElement = Array.from(
      doc.querySelectorAll<HTMLElement>("input[type=email]")
    )[0];
    const emailId = emailElement?.getAttribute(STRUCTURAL_ID_ATTR) ?? null;

    const collected = collectStructuralMap(doc, state, false);
    if (emailElement && emailId) {
      setNativeValue(doc, emailElement, "alice@example.com!");
      const after = collectStructuralMap(doc, state, false);
      const onlyEmail = after.changedCount === 1 && after.redactionIds.length === 1 && after.redactionIds[0] === emailId;
      console.log(
        `\n[phase2] single-char typing → changed ${after.changedCount} / ${after.map.length} total ` +
          `(re-processed id: ${after.redactionIds.join(",") || "none"}) → ${onlyEmail ? "PASS" : "FAIL"}`
      );
    } else {
      console.log("\n[phase2] email field not found — skipping single-char check");
    }
    void collected;

    console.log("\n[phase2] delta summary per step: " +
      deltaSteps.map((s) => `${s.metrics.changedElements}/${s.metrics.totalElements}`).join(", "));

    formatTable(deltaSteps, fullSteps);
  } finally {
    server.kill();
  }
}

main().catch((error) => {
  console.error("[profile] harness failed:", error);
  process.exitCode = 1;
});