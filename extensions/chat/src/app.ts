/**
 * Chat Extension — shared constants and bridge for page components.
 */

import type { PlatformBridge } from "@claudia/ui";

// Same-origin: SPA is served by the gateway
export const GATEWAY_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

export const bridge: PlatformBridge = {
  platform: "web",
  gatewayUrl: GATEWAY_URL,
  showContextBar: false,
  includeFileContext: false,
  saveDraft: (text) => localStorage.setItem("claudia-draft", text),
  loadDraft: () => localStorage.getItem("claudia-draft") || "",
  copyToClipboard: (text) => navigator.clipboard.writeText(text),
};
