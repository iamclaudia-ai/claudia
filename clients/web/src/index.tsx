import { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { ClaudiaChat, WorkspaceList, SessionList } from "@claudia/ui";
import type { PlatformBridge } from "@claudia/ui";
import "@claudia/ui/styles";

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

// ── Gateway URL Discovery ───────────────────────────────────

// Fallback for local dev — overridden by /api/config at runtime
const DEFAULT_GATEWAY_URL = "ws://localhost:30086/ws";

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

function App() {
  const route = useHashRoute();
  const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);

  // Fetch gateway URL from server config on startup
  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        const url = data.gatewayUrl || DEFAULT_GATEWAY_URL;
        console.log(`[Config] Gateway URL: ${url}`);
        setGatewayUrl(url);
      })
      .catch(() => {
        console.warn("[Config] Failed to fetch /api/config, using default");
        setGatewayUrl(DEFAULT_GATEWAY_URL);
      });
  }, []);

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

  // Show loading while discovering gateway
  if (!gatewayUrl) {
    return (
      <div className="flex items-center justify-center h-screen text-gray-400 text-sm">
        Connecting to Claudia Gateway…
      </div>
    );
  }

  const bridge = makeBridge(gatewayUrl);

  switch (route.page) {
    case "workspaces":
      return (
        <WorkspaceList
          gatewayUrl={gatewayUrl}
          onSelectWorkspace={handleSelectWorkspace}
          onSessionReady={handleSessionReady}
        />
      );

    case "workspace":
      return (
        <SessionList
          gatewayUrl={gatewayUrl}
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
