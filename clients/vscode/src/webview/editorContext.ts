/**
 * Reactive editor context store for VS Code webview.
 *
 * Uses useSyncExternalStore to efficiently make extension host -> webview
 * context messages reactive in React without re-creating the bridge.
 */

import { useSyncExternalStore } from "react";
import type { EditorContext } from "@claudia/ui";

let editorContext: EditorContext | undefined;
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return editorContext;
}

/** Update context from extension host message */
export function setEditorContext(ctx: EditorContext | undefined) {
  editorContext = ctx;
  listeners.forEach((cb) => cb());
}

/** React hook for reactive editor context */
export function useEditorContext(): EditorContext | undefined {
  return useSyncExternalStore(subscribe, getSnapshot);
}
