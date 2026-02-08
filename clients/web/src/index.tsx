import { createRoot } from "react-dom/client";
import { ClaudiaChat } from "@claudia/ui";
import type { PlatformBridge } from "@claudia/ui";
import "@claudia/ui/styles";

// Gateway URL - connects directly to Claudia Gateway
const GATEWAY_URL = "ws://localhost:30086/ws";

const webBridge: PlatformBridge = {
  platform: "web",
  gatewayUrl: GATEWAY_URL,
  showContextBar: false,
  includeFileContext: false,

  saveDraft: (text) => localStorage.setItem("claudia-draft", text),
  loadDraft: () => localStorage.getItem("claudia-draft") || "",
  copyToClipboard: (text) => navigator.clipboard.writeText(text),
};

createRoot(document.getElementById("root")!).render(
  <ClaudiaChat bridge={webBridge} />,
);
