import { createRoot } from "react-dom/client";
import { Router } from "@claudia/ui";
import "@claudia/ui/styles";

import { chatRoutes } from "@claudia/ext-chat/routes";
import { missionControlRoutes } from "@claudia/ext-mission-control/routes";

if (window.location.hash.startsWith("#/")) {
  const path = window.location.hash.slice(1);
  window.history.replaceState(null, "", path);
}

if (import.meta.env.DEV) {
  const script = document.createElement("script");
  script.src = "https://unpkg.com/react-grab/dist/index.global.js";
  script.crossOrigin = "anonymous";
  document.head.appendChild(script);
}

const allRoutes = [
  ...missionControlRoutes,
  ...chatRoutes,
];

createRoot(document.getElementById("root")!).render(
  <Router routes={allRoutes} />,
);
