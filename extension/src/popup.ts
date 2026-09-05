import "./style.css";
import { getVisionBackend, runVisionAnalysis, runVisionModel } from "./vision.ts";
import { redact, redactStructuralMap, selfVerifyRedaction, type OcrPipeline } from "./redaction.ts";
import { runOcr } from "./pii.ts";
import { classifyOcrLines } from "./pii-detection.ts";
import type { BoundingBox, ElementNode, SensitiveHit, VisualSensitivityHit } from "./dom-sensitivity.ts";
import {
  startTimer,
  type PipelineMetrics,
  type PipelineTimings,
  type ServerTimings
} from "./pipeline-timing.ts";

const activateButton = document.querySelector<HTMLButtonElement>("#activate-agent");
const visionButton = document.querySelector<HTMLButtonElement>("#vision-self-test");
const redactionDebugButton = document.querySelector<HTMLButtonElement>(
  "#redaction-debug"
);
const capturePreview =
  document.querySelector<HTMLImageElement>("#capture-preview");
const statusText = document.querySelector<HTMLParagraphElement>("#status");
const redactDebugSection = document.querySelector<HTMLElement>("#redact-debug");
const redactRawCanvas = document.querySelector<HTMLCanvasElement>("#redact-raw");
const redactRedactedCanvas = document.querySelector<HTMLCanvasElement>(
  "#redact-redacted"
);
const redactKeyList = document.querySelector<HTMLUListElement>("#redact-key-list");
const redactKeyCount = document.querySelector<HTMLSpanElement>("#redact-key-count");
const perfMeta = document.querySelector<HTMLDivElement>("#perf-meta");
const perfTableBody = document.querySelector<HTMLTableSectionElement>("#perf-table-body");
const perfTotal = document.querySelector<HTMLTableHeaderCellElement>("#perf-total");

type RedactDebugResponse = {
  structuralMap: ElementNode[];
  domHits: SensitiveHit[];
  devicePixelRatio: number;
};

type ActivationRequest = {
  type: "SECURELINK_ACTIVATE_AGENT";
  sessionId: string;
  screenshotBase64: string;
  task: string;
};

type ActivationResponse = {
  ok: boolean;
  title: string;
  action?: unknown;
  error?: string;
  timings?: PipelineTimings;
};

type PerfUpdateMessage = {
  type: "SECURELINK_PERF_UPDATE";
  sessionId: string;
  timings: PipelineTimings;
  server: ServerTimings | null;
  metrics: PipelineMetrics;
};

const STAGE_ROWS: Array<{ key: keyof PipelineTimings; label: string }> = [
  { key: "capture", label: "Screenshot capture" },
  { key: "structuralMap", label: "Structural map" },
  { key: "vitInference", label: "Local ViT inference" },
  { key: "sensitiveDetection", label: "Sensitive detection (DOM)" },
  { key: "redaction", label: "Redaction" },
  { key: "verify", label: "Self-verification" },
  { key: "networkRoundTrip", label: "Network round trip" },
  { key: "actionExecution", label: "Action execution" }
];

const SERVER_ROWS: Array<{ key: keyof ServerTimings; label: string }> = [
  { key: "firewallMs", label: "Server · privacy firewall" },
  { key: "vlmMs", label: "Server · VLM reasoning" },
  { key: "groundingMs", label: "Server · grounding" }
];

function setStatus(message: string): void {
  if (statusText) {
    statusText.textContent = message;
  }
}

function stripDataUrlPrefix(dataUrl: string): string {
  const [, base64] = dataUrl.split(",", 2);
  return base64 ?? dataUrl;
}

async function captureVisibleTab(): Promise<{
  dataUrl: string;
  screenshotBase64: string;
}> {
  console.info("SecureLink popup: capturing visible tab.");

  const dataUrl = await new Promise<string>((resolve, reject) => {
    chrome.tabs.captureVisibleTab(
      chrome.windows.WINDOW_ID_CURRENT,
      { format: "png" },
      (capturedDataUrl) => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(capturedDataUrl);
      }
    );
  });

  console.info("SecureLink popup: captured visible tab PNG.");
  return {
    dataUrl,
    screenshotBase64: stripDataUrlPrefix(dataUrl)
  };
}

function dataUrlToImageData(dataUrl: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;

      const context = canvas.getContext("2d", { willReadFrequently: true });

      if (!context) {
        reject(new Error("2D canvas context unavailable"));
        return;
      }

      context.drawImage(image, 0, 0);
      resolve(context.getImageData(0, 0, canvas.width, canvas.height));
    };
    image.onerror = () => reject(new Error("Could not decode the captured screenshot."));
    image.src = dataUrl;
  });
}

function imageDataToCanvas(imageData: ImageData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("2D canvas context unavailable");
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

interface TabInfo {
  url?: string;
}

async function isScriptableTab(tab: TabInfo | null): Promise<boolean> {
  const url = tab?.url ?? "";

  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://") ||
    url.startsWith("brave://") ||
    url === ""
  ) {
    return false;
  }

  return true;
}

async function injectContentScript(tabId: number): Promise<void> {
  console.info("SecureLink popup: injecting content script into tab.", tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["assets/content.js"]
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function trySend<T>(tabId: number, message: unknown): Promise<T> {
  return chrome.tabs.sendMessage<typeof message, T>(tabId, message);
}

async function sendActivationMessage(
  tabId: number,
  tab: TabInfo | null,
  message: ActivationRequest
): Promise<ActivationResponse> {
  if (!(await isScriptableTab(tab))) {
    throw new Error(
      "SecureLink can\u2019t run on this page. Try a normal website tab " +
        "(browser-internal pages like the new-tab, edge://, chrome:// or the " +
        "Web Store can\u2019t host content scripts)."
    );
  }

  const attempts = [(): Promise<ActivationResponse> => trySend(tabId, message)];

  // First failure: the page may not have the content script yet (e.g. loaded
  // before the extension). Inject it, then retry once the listener is up.
  const injectAndRetry = async (): Promise<ActivationResponse> => {
    await injectContentScript(tabId);
    await delay(50);
    return trySend(tabId, message);
  };
  attempts.push(injectAndRetry);

  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      console.warn(
        "SecureLink popup: message to tab failed, will retry.",
        error
      );
    }
  }

  throw lastError instanceof Error
    ? new Error(
        "Could not reach the page\u2019s content script. " +
          `(${lastError.message})`
      )
    : new Error("Could not reach the page\u2019s content script.");
}

async function captureTabToImageData(): Promise<ImageData> {
  const { dataUrl } = await captureVisibleTab();
  return dataUrlToImageData(dataUrl);
}

function syntheticGradientImageData(
  width = 1280,
  height = 720
): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("2D canvas context unavailable");
  }

  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#7f7fff");
  gradient.addColorStop(1, "#ff7f7f");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  return context.getImageData(0, 0, width, height);
}

type VisionSelfTestResult = {
  backend: "webgpu" | "wasm";
  source: "tab-capture" | "synthetic";
  totalMs: number;
  logitsLength: number;
  firstLogits: number[];
};

async function runVisionSelfTest(): Promise<VisionSelfTestResult> {
  console.info("SecureLink popup: vision self-test started.");
  setStatus("Running vision self-test...");

  let imageData: ImageData;
  let source: VisionSelfTestResult["source"];

  try {
    imageData = await captureTabToImageData();
    source = "tab-capture";
  } catch (error) {
    console.warn(
      "SecureLink popup: tab capture unavailable, using synthetic test image.",
      error
    );
    imageData = syntheticGradientImageData();
    source = "synthetic";
  }

  const started = performance.now();
  const logits = await runVisionModel(imageData);
  const totalMs = performance.now() - started;
  const backend = await getVisionBackend();

  const result: VisionSelfTestResult = {
    backend,
    source,
    totalMs,
    logitsLength: logits.length,
    firstLogits: Array.from(logits.slice(0, 4))
  };

  console.info(
    `[vision] self-test: backend=${backend} source=${source} ` +
      `total=${totalMs.toFixed(1)} ms logits=${logits.length} ` +
      `first=${result.firstLogits.join(",")}`
  );
  setStatus(
    `Vision OK (${backend}): ${totalMs.toFixed(0)} ms, ` +
      `${logits.length} logits (${source})`
  );

  return result;
}

// ── Phase 3 — live latency overlay ──────────────────────────────────────────

const LAST_PERF_EVENT: PerfUpdateMessage | null = null;

function renderPerf(
  timings: PipelineTimings | null | undefined,
  server: ServerTimings | null | undefined,
  metrics: PipelineMetrics | null | undefined
): void {
  if (!perfTableBody || !perfTotal) {
    return;
  }

  perfTableBody.replaceChildren();

  if (!timings) {
    if (perfMeta) {
      perfMeta.textContent = "Waiting for the first agent step…";
    }
    perfTotal.textContent = "—";
    return;
  }

  const values = STAGE_ROWS.map((row) => timings[row.key] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const scaleMax = Math.max(total, 1);

  for (const [index, row] of STAGE_ROWS.entries()) {
    const value = values[index];
    const share = total > 0 ? (value / total) * 100 : 0;

    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${row.label}</td>` +
      `<td class="num">${Math.round(value)}</td>` +
      `<td class="num">${share < 1 && value > 0 ? "<1" : Math.round(share)}%</td>` +
      `<td class="bar-cell"><span class="bar" style="width:${(value / scaleMax) * 100}%"></span></td>`;
    perfTableBody.appendChild(tr);
  }

  if (server) {
    for (const row of SERVER_ROWS) {
      const value = server[row.key] ?? 0;
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="server-divider">${row.label}</td>` +
        `<td class="num server-divider">${Math.round(value)}</td>` +
        `<td colspan="2" class="server-divider"></td>`;
      perfTableBody.appendChild(tr);
    }
  }

  perfTotal.textContent = `${Math.round(total)} ms`;

  if (perfMeta) {
    if (metrics) {
      perfMeta.textContent =
        `Step ${metrics.step} · ${metrics.deltaUsed ? "delta" : "full"} · ` +
        `${metrics.changedElements} changed / ${metrics.totalElements} total`;
    } else {
      perfMeta.textContent = `Total ${Math.round(total)} ms end-to-end`;
    }
  }
}

async function currentTabSessionId(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    return null;
  }

  return getOrCreateSessionId(tab.id);
}

async function renderLastPerfForCurrentTab(): Promise<void> {
  try {
    const sessionId = await currentTabSessionId();
    const perfKey = sessionId ? `securelink:perf:${sessionId}` : null;

    if (!perfKey) {
      return;
    }

    const stored = await chrome.storage.session.get(perfKey);
    const value = stored?.[perfKey] as
      | { timings?: PipelineTimings; server?: ServerTimings | null; metrics?: PipelineMetrics }
      | undefined;

    renderPerf(value?.timings, value?.server, value?.metrics);
  } catch {
    // Non-fatal: the overlay just stays on its empty state.
  }
}

void renderLastPerfForCurrentTab();

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message !== "object" || message === null) {
    return;
  }
  const perfMessage = message as Partial<PerfUpdateMessage>;

  if (perfMessage.type !== "SECURELINK_PERF_UPDATE") {
    return;
  }

  renderPerf(perfMessage.timings, perfMessage.server, perfMessage.metrics);
});

// ── Measure-only popup stages (capture / ViT / self-verify) ─────────────────

/**
 * Run the ViT + visual/face/OCR analysis and self-verification purely for
 * measurement. Results are never used to alter what is sent to the server
 * (measure-only). Any failure just leaves the stage at 0 ms.
 */
async function measureVisualStages(
  imageData: ImageData
): Promise<{ vitInference: number; verify: number }> {
  const result = { vitInference: 0, verify: 0 };

  try {
    const stop = startTimer();
    const analysis = await runVisionAnalysis(imageData);
    result.vitInference = stop();
    console.info(
      `[perf] vitInference ${result.vitInference.toFixed(1)} ms ` +
        `(${analysis.hits.length} visual hits)`
    );

    try {
      const verifyStop = startTimer();
      const canvas = imageDataToCanvas(imageData);
      const pipeline: OcrPipeline = {
        runOcr: async (sourceCanvas: HTMLCanvasElement) => {
          const context = sourceCanvas.getContext("2d");

          if (!context) {
            throw new Error("2D context unavailable");
          }

          return runOcr(context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height));
        },
        classifyOcrLines
      };
      const verification = await selfVerifyRedaction(
        canvas,
        analysis.hits as VisualSensitivityHit[],
        pipeline,
        { failClosed: false }
      );
      result.verify = verifyStop();
      console.info(
        `[perf] verify ${result.verify.toFixed(1)} ms ` +
          `(safe=${verification.safe}, remaining=${verification.remainingHits.length})`
      );
    } catch (verifyError) {
      console.warn(
        "SecureLink popup: self-verification skipped (measure-only).",
        verifyError
      );
    }
  } catch (visionError) {
    console.warn(
      "SecureLink popup: vision analysis skipped (measure-only).",
      visionError
    );
  }

  return result;
}

async function storePopupStageTimings(
  sessionId: string,
  stages: { capture: number; vitInference: number; verify: number }
): Promise<void> {
  const key = `securelink:perf:${sessionId}`;
  const existing = await chrome.storage.session.get(key);
  const current = (existing?.[key] as Record<string, unknown> | undefined) ?? {};

  await chrome.storage.session.set({
    [key]: {
      ...current,
      ...stages,
      ts: Date.now()
    }
  });
}

const secureLinkWindow = window as typeof window & {
  __secureLinkVisionSelfTest?: typeof runVisionSelfTest;
  __secureLinkRunVision?: typeof runVisionModel;
  __secureLinkVisionBackend?: typeof getVisionBackend;
};

secureLinkWindow.__secureLinkVisionSelfTest = runVisionSelfTest;
secureLinkWindow.__secureLinkRunVision = runVisionModel;
secureLinkWindow.__secureLinkVisionBackend = getVisionBackend;

visionButton?.addEventListener("click", () => {
  void runVisionSelfTest().catch((error) => {
    console.error("SecureLink popup: vision self-test failed.", error);
    setStatus(
      error instanceof Error
        ? `Vision failed: ${error.message}`
        : "Vision failed."
    );
  });
});

async function getOrCreateSessionId(tabId: number): Promise<string> {
  const key = `securelink:session:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  const existing = (stored?.[key] as string | undefined)?.trim();

  if (existing) {
    return existing;
  }

  const sessionId = crypto.randomUUID();
  await chrome.storage.session.set({ [key]: sessionId });
  return sessionId;
}

activateButton?.addEventListener("click", async () => {
  const task = "Activate agent";

  console.info("SecureLink popup: activation requested.");
  setStatus("Capturing tab...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.id) {
    console.warn("SecureLink popup: no active tab found.");
    setStatus("No active tab found.");
    return;
  }

  try {
    const sessionId = await getOrCreateSessionId(tab.id);

    const captureStop = startTimer();
    const screenshot = await captureVisibleTab();
    const captureMs = captureStop();

    if (capturePreview) {
      capturePreview.src = screenshot.dataUrl;
      capturePreview.hidden = false;
    }

    // Measure-only: decode + ViT/visual analysis + self-verify so the overlay
    // and console show real numbers for every stage.
    setStatus("Analyzing visual context...");
    const imageData = await dataUrlToImageData(screenshot.dataUrl);
    const visual = await measureVisualStages(imageData);
    await storePopupStageTimings(sessionId, {
      capture: captureMs,
      vitInference: visual.vitInference,
      verify: visual.verify
    });

    setStatus("Sending page context...");
    console.info("SecureLink popup: sending activation message to tab.", tab.id);
    const response = await sendActivationMessage(tab.id, tab, {
      type: "SECURELINK_ACTIVATE_AGENT",
      sessionId,
      screenshotBase64: screenshot.screenshotBase64,
      task
    });

    console.info("SecureLink popup: received content response.", response);
    renderPerf(response.timings, null, null);
    setStatus(
      response.ok
        ? `Action executed on: ${response.title}`
        : `Connection failed: ${response.error ?? "Unknown error"}`
    );
  } catch (error) {
    console.error("SecureLink popup: activation failed.", error);
    setStatus(
      error instanceof Error
        ? `Activation failed: ${error.message}`
        : "Activation failed."
    );
  }
});

function clearRedactDebug() {
  if (redactKeyList) {
    redactKeyList.replaceChildren();
  }
  if (redactKeyCount) {
    redactKeyCount.textContent = "0";
  }
}

function showRedactDebug(response: RedactDebugResponse) {
  const { structuralMap, domHits, devicePixelRatio } = response;

  void captureTabToImageData()
    .then(async (imageData) => {
      if (!redactRawCanvas || !redactRedactedCanvas) {
        throw new Error("Redaction canvases unavailable");
      }

      redactRawCanvas.width = imageData.width;
      redactRawCanvas.height = imageData.height;
      const rawCtx = redactRawCanvas.getContext("2d");

      if (!rawCtx) {
        throw new Error("2D context unavailable");
      }

      rawCtx.putImageData(imageData, 0, 0);

      const mapById = new Map(structuralMap.map((n) => [n.id, n]));
      const hits = domHits.map((hit) => {
        const node = mapById.get(hit.elementId);
        const b = node?.bbox ?? { x: 0, y: 0, w: 0, h: 0 };

        return {
          bbox: {
            x: b.x * devicePixelRatio,
            y: b.y * devicePixelRatio,
            w: b.w * devicePixelRatio,
            h: b.h * devicePixelRatio
          },
          sensitivityClass: hit.sensitivityClass
        };
      });

      const redactedCanvas = redact(
        redactRawCanvas,
        hits,
        { method: "black", padding: 4 },
      );

      redactRedactedCanvas.width = redactedCanvas.width;
      redactRedactedCanvas.height = redactedCanvas.height;
      const redCtx = redactRedactedCanvas.getContext("2d");

      if (!redCtx) {
        throw new Error("2D context unavailable");
      }

      redCtx.drawImage(redactedCanvas, 0, 0);

      const { redactionKey } = redactStructuralMap(structuralMap, domHits);

      if (redactKeyList) {
        redactKeyList.replaceChildren();

        for (const [token, value] of redactionKey) {
          const li = document.createElement("li");
          const tokenSpan = document.createElement("span");
          tokenSpan.className = "token";
          tokenSpan.textContent = token;
          const valueSpan = document.createElement("span");
          valueSpan.className = "value";
          valueSpan.textContent = value;
          li.append(tokenSpan, valueSpan);
          redactKeyList.appendChild(li);
        }
      }

      if (redactKeyCount) {
        redactKeyCount.textContent = String(redactionKey.size);
      }

      if (redactDebugSection) {
        redactDebugSection.hidden = false;
      }

      const pipeline: OcrPipeline = {
        runOcr: async () => [],
        classifyOcrLines: () => [],
      };

      const verification = await selfVerifyRedaction(
        redactRawCanvas,
        hits,
        pipeline
      );

      if (verification.blocked) {
        setStatus(
          "Could not verify this frame is safe to send."
        );
      } else {
        setStatus(
          `Redaction debug: ${hits.length} hits, ${redactionKey.size} redacted fields`
        );
      }
    })
    .catch((error) => {
      console.error("SecureLink popup: redaction debug failed.", error);
      setStatus(
        error instanceof Error
          ? `Redaction debug failed: ${error.message}`
          : "Redaction debug failed."
      );
    });
}

async function sendRedactDebugMessage(
  tabId: number,
  tab: TabInfo | null
): Promise<RedactDebugResponse> {
  if (!(await isScriptableTab(tab))) {
    throw new Error(
      "SecureLink can\u2019t run on this page. Try a normal website tab."
    );
  }

  const attempts = [
    (): Promise<RedactDebugResponse> =>
      trySend(tabId, { type: "SECURELINK_REDACT_DEBUG" }),
    async (): Promise<RedactDebugResponse> => {
      await injectContentScript(tabId);
      await delay(50);
      return trySend(tabId, { type: "SECURELINK_REDACT_DEBUG" });
    }
  ];

  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    "Could not reach the page\u2019s content script. " +
      (lastError instanceof Error ? `(${lastError.message})` : "")
  );
}

redactionDebugButton?.addEventListener("click", async () => {
  console.info("SecureLink popup: redaction debug requested.");
  setStatus("Capturing tab...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.id) {
    console.warn("SecureLink popup: no active tab found.");
    setStatus("No active tab found.");
    return;
  }

  clearRedactDebug();

  try {
    const response = await sendRedactDebugMessage(tab.id, tab);
    showRedactDebug(response);
  } catch (error) {
    console.error("SecureLink popup: redaction debug failed.", error);
    setStatus(
      error instanceof Error
        ? `Redaction debug failed: ${error.message}`
        : "Redaction debug failed."
    );
  }
});