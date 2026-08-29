import "./style.css";

const activateButton = document.querySelector<HTMLButtonElement>("#activate-agent");
const statusText = document.querySelector<HTMLParagraphElement>("#status");

function setStatus(message: string): void {
  if (statusText) {
    statusText.textContent = message;
  }
}

activateButton?.addEventListener("click", async () => {
  setStatus("Connecting...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.id) {
    setStatus("No active tab found.");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage<{
      type: "SECURELINK_ACTIVATE_AGENT";
    }, { ok: boolean; title: string }>(tab.id, {
      type: "SECURELINK_ACTIVATE_AGENT"
    });

    setStatus(response.ok ? `Connected: ${response.title}` : "Connection failed.");
  } catch {
    setStatus("Content script is not available on this page.");
  }
});
