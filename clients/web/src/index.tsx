import { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { ClaudiaChat, WorkspaceList, SessionList } from "@claudia/ui";
import type { PlatformBridge } from "@claudia/ui";
import "@claudia/ui/styles";

// Load react-grab in dev mode — click any element to see its React component tree
if (import.meta.env.DEV) {
  const script = document.createElement("script");
  script.src = "https://unpkg.com/react-grab/dist/index.global.js";
  script.crossOrigin = "anonymous";
  document.head.appendChild(script);
}

// ── Hash Router ─────────────────────────────────────────────

type Route =
  | { page: "workspaces" }
  | { page: "workspace"; workspaceId: string }
  | { page: "session"; sessionId: string };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");

  // #/workspace/:id
  const wsMatch = path.match(/^workspace\/(.+)$/);
  if (wsMatch) return { page: "workspace", workspaceId: wsMatch[1] };

  // #/session/:id
  const sesMatch = path.match(/^session\/(.+)$/);
  if (sesMatch) return { page: "session", sessionId: sesMatch[1] };

  // Default to workspace list
  return { page: "workspaces" };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

function navigate(hash: string) {
  window.location.hash = hash;
}

// ── Gateway URL ─────────────────────────────────────────────

// Same-origin: SPA is served by the gateway, so WebSocket is on the same host
const GATEWAY_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

function makeBridge(gatewayUrl: string): PlatformBridge {
  return {
    platform: "web",
    gatewayUrl,
    showContextBar: false,
    includeFileContext: false,
    saveDraft: (text) => localStorage.setItem("claudia-draft", text),
    loadDraft: () => localStorage.getItem("claudia-draft") || "",
    copyToClipboard: (text) => navigator.clipboard.writeText(text),
  };
}

// ── App ─────────────────────────────────────────────────────

const bridge = makeBridge(GATEWAY_URL);

function App() {
  const route = useHashRoute();

  const handleSelectWorkspace = useCallback((workspaceId: string) => {
    navigate(`#/workspace/${workspaceId}`);
  }, []);

  const handleSelectSession = useCallback((sessionId: string) => {
    navigate(`#/session/${sessionId}`);
  }, []);

  const handleSessionReady = useCallback((sessionId: string) => {
    navigate(`#/session/${sessionId}`);
  }, []);

  const handleBack = useCallback(() => {
    navigate("#/");
  }, []);

  switch (route.page) {
    case "workspaces":
      return (
        <WorkspaceList
          gatewayUrl={GATEWAY_URL}
          onSelectWorkspace={handleSelectWorkspace}
          onSessionReady={handleSessionReady}
        />
      );

    case "workspace":
      return (
        <SessionList
          gatewayUrl={GATEWAY_URL}
          workspaceId={route.workspaceId}
          onSelectSession={handleSelectSession}
          onBack={handleBack}
        />
      );

    case "session":
      return (
        <ClaudiaChat
          bridge={bridge}
          gatewayOptions={{ sessionId: route.sessionId }}
        />
      );
  }
}

createRoot(document.getElementById("root")!).render(<App />);
