/**
 * Mission Control Extension — Route declarations.
 */

import type { Route } from "@claudia/ui";
import { MissionControlPage } from "./pages/MissionControlPage";
import { LogViewerPage } from "./pages/LogViewerPage";

export const missionControlRoutes: Route[] = [
  { path: "/mission-control", component: MissionControlPage, label: "Mission Control" },
  { path: "/logs", component: LogViewerPage, label: "Logs" },
];
