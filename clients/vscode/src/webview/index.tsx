/**
 * VS Code Webview entry point for Claudia.
 *
 * This file is bundled by `bun build` into a single JS file that
 * the VS Code webview loads. It creates a VS Code-specific bridge
 * and renders the shared ClaudiaChat component.
 */

import { createRoot } from "react-dom/client";
import { ClaudiaChat } from "@claudia/ui";
import type { PlatformBridge } from "@claudia/ui";
import { setEditorContext, useEditorContext } from "./editorContext";
import "@claudia/ui/styles";

// Declare VS Code API (provided by the webview runtime)
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
};

const vscode = acquireVsCodeApi();

// Track external send request callbacks
let sendRequestCallback: ((text: string) => void) | null = null;

// Listen for messages from extension host
window.addEventListener("message", (event) => {
  const msg = event.data;

  switch (msg.type) {
    case "context":
      setEditorContext(msg.context);
      break;

    case "sendMessage":
      if (sendRequestCallback) {
        sendRequestCallback(msg.text);
      }
      break;
  }
});

// Read gateway URL injected by the extension
const gatewayUrl =
  document.documentElement.dataset.gatewayUrl || "ws://localhost:30086/ws";

const vscodeBridge: PlatformBridge = {
  platform: "vscode",
  gatewayUrl,
  showContextBar: true,
  includeFileContext: true,

  // Draft persistence via VS Code webview state
  saveDraft: (text) => {
    const state = vscode.getState() || {};
    vscode.setState({ ...state, draft: text });
  },
  loadDraft: () => {
    const state = vscode.getState();
    return (state?.draft as string) || "";
  },

  // Clipboard via extension host (webview clipboard API is limited)
  copyToClipboard: async (text) => {
    vscode.postMessage({ type: "copyToClipboard", text });
  },

  // VS Code-specific actions via postMessage
  openFile: (path) => vscode.postMessage({ type: "openFile", path }),
  applyEdit: (path, content) =>
    vscode.postMessage({ type: "applyEdit", path, content }),
  openTerminal: () => vscode.postMessage({ type: "openTerminal" }),
  showNotification: (type, text) =>
    vscode.postMessage({
      type: type === "error" ? "showError" : "showInfo",
      text,
    }),

  // Editor context via reactive store
  useEditorContext,

  // External send requests (e.g. "Explain This Code")
  onSendRequest: (callback) => {
    sendRequestCallback = callback;
    return () => {
      sendRequestCallback = null;
    };
  },
};

// Notify extension we're ready
vscode.postMessage({ type: "ready" });

// Render
createRoot(document.getElementById("root")!).render(
  <ClaudiaChat bridge={vscodeBridge} />,
);
