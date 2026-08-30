import "./style.css";

const activateButton = document.querySelector<HTMLButtonElement>("#activate-agent");
const statusText = document.querySelector<HTMLParagraphElement>("#status");

function setStatus(message: string): void {
  if (statusText) {
    statusText.textContent = message;
  }
}

activateButton?.addEventListener("click", async () => {
  const task = "Activate agent";

  console.info("SecureLink popup: activation requested.");
  setStatus("Connecting...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.id) {
    console.warn("SecureLink popup: no active tab found.");
    setStatus("No active tab found.");
    return;
  }

  try {
    console.info("SecureLink popup: sending activation message to tab.", tab.id);
    const response = await chrome.tabs.sendMessage<{
      type: "SECURELINK_ACTIVATE_AGENT";
      task: string;
    }, { ok: boolean; title: string; action?: unknown; error?: string }>(tab.id, {
      type: "SECURELINK_ACTIVATE_AGENT",
      task
    });

    console.info("SecureLink popup: received content response.", response);
    setStatus(
      response.ok
        ? `Action executed on: ${response.title}`
        : `Connection failed: ${response.error ?? "Unknown error"}`
    );
  } catch (error) {
    console.error("SecureLink popup: content connection failed.", error);
    setStatus("Content script is not available on this page.");
  }
});
