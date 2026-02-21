/**
 * Chat Extension — route declarations.
 *
 * These are the core routes for the Claudia web UI:
 * workspace list → session list → chat.
 */

import type { Route } from "@claudia/ui";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { SessionPage } from "./pages/SessionPage";

export const chatRoutes: Route[] = [
  { path: "/", component: WorkspacesPage, label: "Workspaces" },
  { path: "/workspace/:workspaceId", component: WorkspacePage, label: "Sessions" },
  { path: "/workspace/:workspaceId/session/:sessionId", component: SessionPage, label: "Chat" },
];
