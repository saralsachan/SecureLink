type AgentMessage = {
  type: "SECURELINK_ACTIVATE_AGENT";
};

console.info("SecureLink injected into:", document.title);

chrome.runtime.onMessage.addListener(
  (
    message: AgentMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: { ok: boolean; title: string }) => void
  ) => {
    if (message.type !== "SECURELINK_ACTIVATE_AGENT") {
      return false;
    }

    console.info("SecureLink popup connected on:", document.title);
    sendResponse({ ok: true, title: document.title });
    return false;
  }
);
