import { createRoot } from "react-dom/client";
import { Router } from "@claudia/ui";
import "@claudia/ui/styles";

// Extension routes — each extension declares its own pages
import { chatRoutes } from "@claudia/ext-chat/routes";
// import { voiceRoutes } from "@claudia/voice/routes";  // future

// Migrate hash routes → clean URLs (one-time for old bookmarks)
if (window.location.hash.startsWith("#/")) {
  const path = window.location.hash.slice(1);
  window.history.replaceState(null, "", path);
}

// Load react-grab in dev mode — click any element to see its React component tree
if (import.meta.env.DEV) {
  const script = document.createElement("script");
  script.src = "https://unpkg.com/react-grab/dist/index.global.js";
  script.crossOrigin = "anonymous";
  document.head.appendChild(script);
}

// Merge all routes — core chat first, extensions append
const allRoutes = [
  ...chatRoutes,
  // ...voiceRoutes,
];

createRoot(document.getElementById("root")!).render(
  <Router routes={allRoutes} />,
);
