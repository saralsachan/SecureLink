import "./style.css";
import { getVisionBackend, runVisionModel } from "./vision";

const activateButton = document.querySelector<HTMLButtonElement>("#activate-agent");
const visionButton = document.querySelector<HTMLButtonElement>("#vision-self-test");
const capturePreview =
  document.querySelector<HTMLImageElement>("#capture-preview");
const statusText = document.querySelector<HTMLParagraphElement>("#status");

type ActivationRequest = {
  type: "SECURELINK_ACTIVATE_AGENT";
  screenshotBase64: string;
  task: string;
};

type ActivationResponse = {
  ok: boolean;
  title: string;
  action?: unknown;
  error?: string;
};

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

async function injectContentScript(tabId: number): Promise<void> {
  console.info("SecureLink popup: injecting content script into tab.", tabId);

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["assets/content.js"]
  });
}

async function sendActivationMessage(
  tabId: number,
  message: ActivationRequest
): Promise<ActivationResponse> {
  try {
    return await chrome.tabs.sendMessage<ActivationRequest, ActivationResponse>(
      tabId,
      message
    );
  } catch (error) {
    console.warn(
      "SecureLink popup: content script was unavailable, injecting and retrying.",
      error
    );

    await injectContentScript(tabId);
    return chrome.tabs.sendMessage<ActivationRequest, ActivationResponse>(
      tabId,
      message
    );
  }
}

async function captureTabToImageData(): Promise<ImageData> {
  const { dataUrl } = await captureVisibleTab();

  const image = new Image();
  image.src = dataUrl;

  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("2D canvas context unavailable");
  }

  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
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
    const screenshot = await captureVisibleTab();

    if (capturePreview) {
      capturePreview.src = screenshot.dataUrl;
      capturePreview.hidden = false;
    }

    setStatus("Sending page context...");
    console.info("SecureLink popup: sending activation message to tab.", tab.id);
    const response = await sendActivationMessage(tab.id, {
      type: "SECURELINK_ACTIVATE_AGENT",
      screenshotBase64: screenshot.screenshotBase64,
      task
    });

    console.info("SecureLink popup: received content response.", response);
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
