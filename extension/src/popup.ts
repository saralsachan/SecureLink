import "./style.css";

const activateButton = document.querySelector<HTMLButtonElement>("#activate-agent");
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
