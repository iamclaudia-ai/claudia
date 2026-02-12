/**
 * Mission Control Extension — Route declarations.
 */

import type { Route } from "@claudia/ui";
import { MissionControlPage } from "./pages/MissionControlPage";

export const missionControlRoutes: Route[] = [
  { path: "/mission-control", component: MissionControlPage, label: "Mission Control" },
];
