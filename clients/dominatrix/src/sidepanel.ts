/**
 * Side panel script — detects context tab and loads Claudia chat UI in iframe.
 */

export {}; // Force module scope to avoid GATEWAY_URL redeclaration conflict

const GATEWAY_URL = "http://localhost:30086";

const iframe = document.getElementById("chat") as HTMLIFrameElement;
const banner = document.getElementById("banner") as HTMLDivElement;

// Detect which tab the side panel is open on and set it as context
async function initWithTabContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id;

    if (tabId) {
      // Tell background worker which tab we're scoped to
      chrome.runtime.sendMessage({ type: "sidepanel-context", tabId });
      // Load chat UI with tab context in URL
      iframe.src = `${GATEWAY_URL}/?tabId=${tabId}`;
    } else {
      iframe.src = `${GATEWAY_URL}/`;
    }
  } catch {
    iframe.src = `${GATEWAY_URL}/`;
  }
}

// Track tab changes — if user switches tabs while panel is open
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.runtime.sendMessage({ type: "sidepanel-context", tabId: activeInfo.tabId });
});

initWithTabContext();

iframe.addEventListener("load", () => {
  banner.classList.remove("visible");
});

iframe.addEventListener("error", () => {
  banner.textContent = "Cannot connect to Claudia gateway";
  banner.classList.add("visible");
});

// Health check retry
let retryCount = 0;
function checkConnection() {
  fetch(`${GATEWAY_URL}/health`)
    .then((r) => r.json())
    .then(() => {
      banner.classList.remove("visible");
      retryCount = 0;
    })
    .catch(() => {
      retryCount++;
      if (retryCount > 2) {
        banner.textContent = "Cannot connect to Claudia gateway — is it running?";
        banner.classList.add("visible");
      }
      setTimeout(checkConnection, 5000);
    });
}
checkConnection();
