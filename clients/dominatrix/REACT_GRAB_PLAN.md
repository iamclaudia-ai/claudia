# DOMINATRIX: Main World Bridge + React Source Mapping

## Problem: Content Script Isolation

Chrome content scripts run in an **isolated world** — they share the DOM tree with the page but have a completely separate JavaScript context. This means:

- `Object.keys(element)` from a content script returns `[]` — can't see `__reactFiber$`, `__vue__`, etc.
- `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` is `undefined` from the content script
- Any property set by the page's JS is invisible to the content script

This is a fundamental Chrome extension limitation. We need a **main world bridge** to cross this boundary.

## Solution: Main World Bridge (Framework-Agnostic)

Inject a lightweight bridge script into the page's **main world** (`world: "MAIN"`) that:

1. Can access all page-level JS properties (React fibers, Vue internals, app state, etc.)
2. Communicates with the content script via `CustomEvent` on `document`
3. Executes queries on demand — content script sends a request, bridge returns results
4. Is framework-agnostic — the bridge is a general-purpose RPC mechanism

```
Content Script (isolated world)          Main World Bridge (page context)
┌─────────────────────────────┐         ┌─────────────────────────────┐
│ refMap, snapshot, click...  │         │ Access to __reactFiber$,    │
│                             │  Event  │ __vue__, window globals,    │
│ dispatch('dmx-bridge-req')──┼────────>│ app state, etc.             │
│                             │         │                             │
│ listen('dmx-bridge-res') <──┼─────────┤ dispatch('dmx-bridge-res')  │
└─────────────────────────────┘         └─────────────────────────────┘
```

### Why Not Just Use `exec`/`eval`?

The existing `exec` and `eval` commands run via the background worker → `chrome.scripting.executeScript`. That works for one-off JS, but:

- Can't reference DOM elements from the content script's `refMap`
- Each call has round-trip overhead (content script → background → chrome.scripting → page → back)
- No way to pass DOM element references across the boundary

The main world bridge runs **in the same page**, shares the DOM, and communicates via synchronous-ish events. The content script can stamp a unique attribute on an element (e.g., `data-dmx-target`), tell the bridge to find it, and the bridge accesses the element's page-world properties.

## Goal

Given a `@ref` from a snapshot, return the React component ancestry and source file paths:

```
"I see a bug on this button"
  → claudia dominatrix get-source --ref @e35
  → PostEditor.tsx:87 (in PostEditor → DashboardPage → AppLayout)
```

### Relationship with react-grab

react-grab remains a separate, complementary tool for **interactive** use — hover to inspect, click to copy, visual overlay. Dominatrix's source mapping is for **programmatic** use by AI agents via CLI.

|                      | react-grab                                 | dominatrix get-source                                                                          |
| -------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Use case**         | Interactive — human hovers/clicks elements | Programmatic — AI queries by @ref                                                              |
| **Requires loading** | Yes — script tag or npm import             | No — reads React fiber internals directly                                                      |
| **Full ancestry**    | Via clipboard copy                         | Via fiber `.return` walk                                                                       |
| **Source maps**      | bippy resolves bundled→original paths      | Same technique — `_debugSource` first, then stack trace + source map symbolication (Phase 1.5) |
| **Works without it** | N/A                                        | Yes — zero dependencies on page                                                                |

## What We're Building

### 1. `dominatrix.get-source` — Single Element Source Lookup

```bash
claudia dominatrix get-source --ref @e12
# → {
#   "component": "PostCard",
#   "file": "src/components/PostCard.tsx",
#   "line": 42,
#   "ancestry": [
#     { "name": "PostCard", "file": "src/components/PostCard.tsx", "line": 42 },
#     { "name": "PostList", "file": "src/routes/posts/PostList.tsx", "line": 18 },
#     { "name": "PostsPage", "file": "src/routes/posts/PostsPage.tsx", "line": 7 }
#   ]
# }

claudia dominatrix get-source --selector ".my-button"
# Same, but via CSS selector
```

### 2. `dominatrix.snapshot --sources` — Enriched Snapshot

```bash
claudia dominatrix snapshot --sources
# Page: beehiiv Dashboard
# URL: https://app.beehiiv.com/dashboard
#
# @e1 [a] "Dashboard" ← NavLink (Sidebar.tsx:23)
# @e2 [a] "Posts" ← NavLink (Sidebar.tsx:24)
# @e3 [button] "View site" ← Button (Header.tsx:15) → DashboardLayout
# @e4 [input type="email"] ← EmailInput (SubscribeForm.tsx:8) → WidgetCard
```

Opt-in flag because it's slower (bridge call per element).

## Implementation Plan

### Phase 0: Main World Bridge (Framework-Agnostic)

**New file: `clients/dominatrix/src/main-world-bridge.ts`**

A small script injected into the page's main world. It listens for requests from the content script and executes queries that require page-level JS access.

```ts
// main-world-bridge.ts — runs in page's MAIN world
// Injected via chrome.scripting.executeScript({ world: "MAIN" }) or <script> tag

(function () {
  if ((window as any).__dominatrix_bridge__) return; // idempotent
  (window as any).__dominatrix_bridge__ = true;

  // Listen for requests from content script
  document.addEventListener("dmx-bridge-req", (e: CustomEvent) => {
    const { id, method, selector } = e.detail;
    let result: any;
    let error: string | null = null;

    try {
      const el = selector ? document.querySelector(selector) : null;

      switch (method) {
        case "get-react-ancestry": {
          result = getReactAncestry(el);
          break;
        }
        case "get-page-global": {
          // Generic: read any window property
          // e.detail.path = "myApp.state.user" → window.myApp.state.user
          const path = e.detail.path;
          result = path.split(".").reduce((o: any, k: string) => o?.[k], window);
          // Serialize to prevent structured clone issues
          result = JSON.parse(JSON.stringify(result ?? null));
          break;
        }
        case "get-element-keys": {
          // Debug: list all keys on an element (including __reactFiber$, __vue__, etc.)
          if (el) {
            result = Object.keys(el).filter((k) => k.startsWith("__") || k.startsWith("$"));
          }
          break;
        }
        default:
          error = `Unknown bridge method: ${method}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // Send response back to content script
    document.dispatchEvent(
      new CustomEvent("dmx-bridge-res", {
        detail: { id, result, error },
      }),
    );
  });

  // --- React-specific helpers (run in main world where fibers are visible) ---

  interface ComponentSource {
    name: string;
    file: string | null;
    line: number | null;
  }

  function getReactAncestry(element: Element | null): ComponentSource[] | null {
    if (!element) return null;

    // Find the fiber key — React attaches fibers as __reactFiber$<random>
    const fiberKey = Object.keys(element).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
    );
    if (!fiberKey) return null;

    const fiber = (element as any)[fiberKey];
    if (!fiber) return null;

    const ancestry: ComponentSource[] = [];
    let current = fiber;

    while (current) {
      // tag 0 = FunctionComponent, 1 = ClassComponent, 11 = ForwardRef, 15 = SimpleMemoComponent
      if ([0, 1, 11, 15].includes(current.tag)) {
        const type = current.type;
        // ForwardRef/memo wrap the real component in .render or .type
        const resolvedType = type?.render || type?.type || type;
        const name = type?.displayName || resolvedType?.displayName || resolvedType?.name || null;
        if (name) {
          const source = current._debugSource;
          ancestry.push({
            name,
            file: source?.fileName || null,
            line: source?.lineNumber || null,
          });
        }
      }
      current = current.return;
    }

    return ancestry.length > 0 ? ancestry : null;
  }
})();
```

**Content script side — bridge client helper:**

```ts
// In content-script.ts — helper to call the main world bridge

let bridgeReady = false;

async function ensureBridge(): Promise<void> {
  if (bridgeReady) return;
  // Bridge is injected by background.ts via chrome.scripting.executeScript({ world: "MAIN" })
  // Or we inject it ourselves via a <script> tag
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("main-world-bridge.js");
  (document.head || document.documentElement).appendChild(script);
  script.remove(); // Clean up — script has already executed
  bridgeReady = true;
}

let bridgeCallId = 0;

async function callBridge(method: string, detail: Record<string, any> = {}): Promise<any> {
  await ensureBridge();
  const id = `dmx-${++bridgeCallId}`;

  return new Promise((resolve, reject) => {
    const handler = (e: CustomEvent) => {
      if (e.detail.id !== id) return;
      document.removeEventListener("dmx-bridge-res", handler as EventListener);
      if (e.detail.error) reject(new Error(e.detail.error));
      else resolve(e.detail.result);
    };
    document.addEventListener("dmx-bridge-res", handler as EventListener);

    document.dispatchEvent(
      new CustomEvent("dmx-bridge-req", {
        detail: { id, method, ...detail },
      }),
    );

    // Timeout after 5s
    setTimeout(() => {
      document.removeEventListener("dmx-bridge-res", handler as EventListener);
      reject(new Error(`Bridge call timed out: ${method}`));
    }, 5000);
  });
}
```

**Element targeting across worlds:**

The content script has `refMap` with direct DOM references, but the bridge needs to find the same element. Strategy:

```ts
// Content script stamps a temporary attribute, bridge queries it
function callBridgeForElement(method: string, element: Element): Promise<any> {
  const marker = `dmx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  element.setAttribute("data-dmx-target", marker);
  try {
    return callBridge(method, { selector: `[data-dmx-target="${marker}"]` });
  } finally {
    // Clean up after a tick (bridge reads synchronously in the event handler)
    requestAnimationFrame(() => element.removeAttribute("data-dmx-target"));
  }
}
```

**Manifest changes:**

```json
{
  "web_accessible_resources": [
    {
      "resources": ["main-world-bridge.js"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

Or alternatively, inject via `background.ts`:

```ts
// In background.ts — inject bridge into main world
async function injectMainWorldBridge(tabId: number) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["main-world-bridge.js"],
    world: "MAIN",
  });
}
```

**Build changes:**

- `main-world-bridge.ts` needs to be a **separate entry point** in the build (not bundled into `content-script.js`)
- Add to tsconfig/build config as an additional entry

### Phase 1: `get-source` Handler Using Bridge

**File: `clients/dominatrix/src/content-script.ts`**

```ts
case "get-source": {
  const el = resolveElement(message.ref, message.selector);
  if (!el) throw new Error("Element not found");

  const ancestry = await callBridgeForElement("get-react-ancestry", el);

  if (!ancestry || ancestry.length === 0) {
    throw new Error(
      "No React component found for this element. " +
      "Possible causes: not a React app, production build, or element is a plain HTML node."
    );
  }

  const nearest = ancestry[0];
  result = {
    component: nearest.name,
    file: nearest.file,
    line: nearest.line,
    ancestry,
  };
  break;
}
```

### Phase 2: Enriched Snapshot with Sources

**File: `clients/dominatrix/src/content-script.ts`**

Update `getInteractiveSnapshot()` to accept a `sources` flag. Since bridge calls are async, the snapshot needs to await them:

```ts
async function getInteractiveSnapshot(scope?: string, sources?: boolean): Promise<string> {
  // ... existing snapshot logic (collecting elements, building refs) ...

  for (const element of interactiveElements) {
    const ref = nextRef();
    refMap.set(ref, element);
    let line = formatRefLine(ref, element);

    if (sources) {
      try {
        const ancestry = await callBridgeForElement("get-react-ancestry", element);
        if (ancestry && ancestry.length > 0) {
          const nearest = ancestry[0];
          const shortFile = nearest.file?.replace(/^.*?\/src\//, "src/") || "";
          const chain = ancestry
            .slice(1, 3)
            .map((c: any) => c.name)
            .join(" → ");
          line += ` <- ${nearest.name}`;
          if (shortFile) line += ` (${shortFile}${nearest.line ? `:${nearest.line}` : ""})`;
          if (chain) line += ` → ${chain}`;
        }
      } catch {
        // Skip source annotation for this element — not a React element
      }
    }

    lines.push(line);
  }
  // ...
}
```

**Note:** Making snapshot async for sources means the message handler needs to await it. The non-sources path can stay synchronous for speed.

### Phase 3: Gateway Extension Updates

**File: `extensions/dominatrix/src/index.ts`**

1. **Update snapshot schema** — add `sources` boolean:

```ts
const snapshotParam = z.object({
  tabId: z.number().optional().describe("Target tab ID"),
  full: z.boolean().optional().describe("Full a11y tree instead of interactive refs"),
  scope: z.string().optional().describe("CSS selector to scope snapshot"),
  sources: z.boolean().optional().describe("Include React component source info per element"),
});
```

2. **Add `dominatrix.get-source` method**:

```ts
const getSourceParam = z.object({
  tabId: z.number().optional().describe("Target tab ID"),
  ref: z.string().optional().describe("Element ref from snapshot (e.g. @e3)"),
  selector: z.string().optional().describe("CSS selector"),
});

// In methods array:
{
  name: "dominatrix.get-source",
  description: "Get React component ancestry and source file path for an element",
  inputSchema: getSourceParam,
}

// In method handlers:
"dominatrix.get-source": (p) => sendCommand("get-source", p),
```

### Phase 4: Skill Documentation

**File: `~/.claude/skills/controlling-the-browser/SKILL.md`**

Update the React Source Mapping section (already present — just ensure accuracy).

## Files to Modify / Create

| File                                                | Changes                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **`clients/dominatrix/src/main-world-bridge.ts`**   | **NEW** — Main world bridge script (event listener + React ancestry walker)                                      |
| `clients/dominatrix/src/content-script.ts`          | Add `callBridge()`, `callBridgeForElement()`, `ensureBridge()`, `get-source` handler, `sources` flag in snapshot |
| `clients/dominatrix/manifest.json`                  | Add `main-world-bridge.js` to `web_accessible_resources`                                                         |
| `clients/dominatrix/build config`                   | Add `main-world-bridge.ts` as separate entry point                                                               |
| `extensions/dominatrix/src/index.ts`                | `dominatrix.get-source` method + schema, `sources` param on snapshot schema                                      |
| `~/.claude/skills/controlling-the-browser/SKILL.md` | Verify source mapping docs are accurate                                                                          |

**Phase 1.5 additions to `main-world-bridge.ts`:**

- `getComponentBundledLocation()` — generates stack traces from component functions
- `getSourceMap()` — fetches and caches bundle source maps
- `resolveFromSourceMap()` — VLQ decoder + position mapping
- `normalizeSourcePath()` — strips bundler prefixes
- `getReactAncestryWithSources()` — async version that tries `_debugSource`, falls back to source maps
- `sourceMapCache` / `componentSourceCache` — caching layer

### Phase 1.5: Source Map Symbolication (Production File Path Resolution)

**Problem:** On production/bundled builds, `_debugSource` is stripped, so file/line are `null`. But the component functions still exist in the bundle — we can generate stack traces and resolve them via source maps to get original file paths.

This is the same technique react-grab/bippy uses. It works on any build that ships source maps (dev, staging, and many production builds).

**How it works:**

```
Component function → synthetic Error → stack trace → bundled location → source map → original file
```

1. **Generate stack trace for a component** — Call the component's function (or `toString()` it) inside a try/catch to get a stack frame pointing to the bundled JS file + line/column
2. **Fetch the source map** — Parse `//# sourceMappingURL=` from the bundle, fetch the `.map` file
3. **Resolve original location** — Use the source map mappings to convert bundled line:col → original file:line

**New bridge method: `get-react-ancestry-with-sources`**

```ts
// main-world-bridge.ts additions

// Cache source maps per bundle URL to avoid re-fetching
const sourceMapCache = new Map<string, any>();

interface SourceMapMapping {
  file: string;
  line: number;
  column: number;
}

// Generate a stack trace for a component function to find its bundled location
function getComponentBundledLocation(
  componentFn: Function,
): { url: string; line: number; col: number } | null {
  // Method 1: Create an Error at the component's call site
  // React components are just functions — we can extract location from their toString or by calling them
  try {
    const err = new Error();
    const origPrepare = Error.prepareStackTrace;

    // V8-specific: structured stack trace API
    let frame: any = null;
    Error.prepareStackTrace = (_err, stack) => {
      // Find the frame that corresponds to the component function
      frame = stack[0]; // Caller is the component
      return stack;
    };

    // Try calling the component to capture its stack
    // Wrap in a way that catches but captures the call site
    try {
      // Create a fake React-like call that triggers the function
      const fakeProps = {};
      componentFn(fakeProps);
    } catch {
      // Expected — component will likely throw without proper context
    }

    Error.prepareStackTrace = origPrepare;

    if (frame) {
      return {
        url: frame.getFileName(),
        line: frame.getLineNumber(),
        col: frame.getColumnNumber(),
      };
    }
  } catch {
    // Fall through
  }

  // Method 2: Parse Error.stack string
  try {
    // Manufacture an error by calling the function
    let stack: string = "";
    const origFn = componentFn;

    try {
      // Wrap in proxy to capture the stack at call time
      const err = new Error();
      stack = err.stack || "";
    } catch {
      // Ignore
    }

    // Try: call the component and catch, parsing the resulting stack
    try {
      componentFn({});
    } catch (e: any) {
      if (e?.stack) stack = e.stack;
    }

    // Parse Chrome-style stack: "    at FnName (https://example.com/bundle.js:123:45)"
    const match = stack.match(/at\s+\S+\s+\((.+?):(\d+):(\d+)\)/);
    if (match) {
      return { url: match[1], line: parseInt(match[2]), col: parseInt(match[3]) };
    }
  } catch {
    // Fall through
  }

  return null;
}

// Fetch and cache a source map for a bundle URL
async function getSourceMap(bundleUrl: string): Promise<any | null> {
  if (sourceMapCache.has(bundleUrl)) return sourceMapCache.get(bundleUrl);

  try {
    // Fetch the bundle to find the sourceMappingURL
    const bundleRes = await fetch(bundleUrl);
    const bundleText = await bundleRes.text();

    // Look for //# sourceMappingURL=...
    const match = bundleText.match(/\/\/[#@]\s*sourceMappingURL=(.+?)[\s\n]*$/m);
    if (!match) {
      sourceMapCache.set(bundleUrl, null);
      return null;
    }

    let mapUrl = match[1].trim();

    // Resolve relative URLs
    if (!mapUrl.startsWith("http") && !mapUrl.startsWith("data:")) {
      const base = bundleUrl.substring(0, bundleUrl.lastIndexOf("/") + 1);
      mapUrl = base + mapUrl;
    }

    // Handle data: URIs (inline source maps)
    let mapData: any;
    if (mapUrl.startsWith("data:")) {
      const b64 = mapUrl.split(",")[1];
      mapData = JSON.parse(atob(b64));
    } else {
      const mapRes = await fetch(mapUrl);
      mapData = await mapRes.json();
    }

    sourceMapCache.set(bundleUrl, mapData);
    return mapData;
  } catch {
    sourceMapCache.set(bundleUrl, null);
    return null;
  }
}

// Decode VLQ-encoded source map mappings and resolve a position
// Uses the "mappings" field from the source map spec
function resolveFromSourceMap(sourceMap: any, line: number, col: number): SourceMapMapping | null {
  // Source maps use VLQ encoding — we need a basic decoder
  // For robustness, we use the browser's built-in if available,
  // or a minimal VLQ decoder

  // Approach: Use the browser's fetch + wasm-based decoder if available
  // Fallback: Minimal VLQ implementation

  const vlqChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function decodeVLQ(encoded: string): number[] {
    const values: number[] = [];
    let shift = 0;
    let value = 0;

    for (const char of encoded) {
      const digit = vlqChars.indexOf(char);
      if (digit === -1) continue;

      const cont = digit & 32; // continuation bit
      const raw = digit & 31; // 5 bits of value
      value += raw << shift;

      if (cont) {
        shift += 5;
      } else {
        // Final digit — apply sign
        const isNeg = value & 1;
        value = value >> 1;
        values.push(isNeg ? -value : value);
        value = 0;
        shift = 0;
      }
    }

    return values;
  }

  try {
    const lines = sourceMap.mappings.split(";");
    if (line - 1 >= lines.length) return null;

    const targetLine = lines[line - 1];
    if (!targetLine) return null;

    const segments = targetLine.split(",");

    // State for decoding (relative values)
    let genCol = 0;
    let srcFileIdx = 0;
    let srcLine = 0;
    let srcCol = 0;

    // We need cumulative state from all previous lines
    let cGenCol = 0,
      cSrcFileIdx = 0,
      cSrcLine = 0,
      cSrcCol = 0;

    // Process all lines up to and including target to maintain state
    for (let l = 0; l < line; l++) {
      const lineSegs = lines[l]?.split(",") || [];
      genCol = 0; // genCol resets per line

      for (const seg of lineSegs) {
        if (!seg) continue;
        const decoded = decodeVLQ(seg);
        if (decoded.length >= 4) {
          genCol += decoded[0];
          cSrcFileIdx += decoded[1];
          cSrcLine += decoded[2];
          cSrcCol += decoded[3];

          // Check if this is our target line and column matches
          if (l === line - 1 && genCol >= col - 1) {
            // Found it (or closest)
            const sourceFile = sourceMap.sources?.[cSrcFileIdx] || null;
            if (sourceFile) {
              return {
                file: normalizeSourcePath(sourceFile, sourceMap.sourceRoot),
                line: cSrcLine + 1, // 1-indexed
                column: cSrcCol + 1,
              };
            }
          }
        }
      }
    }

    // If exact col not found, return the last segment on the target line
    const sourceFile = sourceMap.sources?.[cSrcFileIdx] || null;
    if (sourceFile) {
      return {
        file: normalizeSourcePath(sourceFile, sourceMap.sourceRoot),
        line: cSrcLine + 1,
        column: cSrcCol + 1,
      };
    }
  } catch {
    // Source map parsing failed
  }

  return null;
}

// Strip bundler prefixes from source paths
function normalizeSourcePath(filePath: string, sourceRoot?: string): string {
  let normalized = filePath;

  // Strip common bundler prefixes
  const prefixes = [
    /^webpack:\/\/\/?\.\//, // webpack:///./src/...
    /^webpack:\/\/[^/]*\//, // webpack://appname/src/...
    /^turbopack:\/\/\[project\]\//, // turbopack://[project]/src/...
    /^turbopack:\/\/\/?\.\//, // turbopack:///./src/...
    /^\.\//, // ./src/...
    /^\/?\.\//, // /./src/...
    /^rsc:\/\/React\//, // rsc://React/...
    /^file:\/\//, // file:///...
  ];

  for (const prefix of prefixes) {
    normalized = normalized.replace(prefix, "");
  }

  // Apply sourceRoot if present and path is relative
  if (sourceRoot && !normalized.startsWith("/")) {
    normalized = sourceRoot.replace(/\/$/, "") + "/" + normalized;
  }

  return normalized;
}
```

**Updated `getReactAncestry` to use source maps:**

```ts
// Replace Phase 0's getReactAncestry with this async version

async function getReactAncestryWithSources(
  element: Element | null,
): Promise<ComponentSource[] | null> {
  if (!element) return null;

  const fiberKey = Object.keys(element).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
  );
  if (!fiberKey) return null;

  const fiber = (element as any)[fiberKey];
  if (!fiber) return null;

  const ancestry: ComponentSource[] = [];
  let current = fiber;

  // Collect components first
  const components: { name: string; type: any; debugSource: any }[] = [];

  while (current) {
    if ([0, 1, 11, 15].includes(current.tag)) {
      const type = current.type;
      const resolvedType = type?.render || type?.type || type;
      const name = type?.displayName || resolvedType?.displayName || resolvedType?.name || null;
      if (name) {
        components.push({
          name,
          type: resolvedType,
          debugSource: current._debugSource,
        });
      }
    }
    current = current.return;
  }

  if (components.length === 0) return null;

  // For each component, try _debugSource first, then fall back to source map resolution
  for (const comp of components) {
    let file: string | null = null;
    let line: number | null = null;

    // Priority 1: _debugSource (dev builds)
    if (comp.debugSource?.fileName) {
      file = normalizeSourcePath(comp.debugSource.fileName);
      line = comp.debugSource.lineNumber || null;
    }

    // Priority 2: Source map symbolication (production builds)
    if (!file && typeof comp.type === "function") {
      try {
        const loc = getComponentBundledLocation(comp.type);
        if (loc) {
          const sourceMap = await getSourceMap(loc.url);
          if (sourceMap) {
            const resolved = resolveFromSourceMap(sourceMap, loc.line, loc.col);
            if (resolved) {
              file = resolved.file;
              line = resolved.line;
            }
          }
        }
      } catch {
        // Source map resolution failed — continue with null
      }
    }

    ancestry.push({ name: comp.name, file, line });
  }

  return ancestry;
}
```

**Updated bridge handler to support both sync and async:**

```ts
// In the bridge's switch statement, update the handler:

case "get-react-ancestry": {
  // Use async version with source map support
  getReactAncestryWithSources(el).then((result) => {
    document.dispatchEvent(
      new CustomEvent("dmx-bridge-res", {
        detail: { id, result, error: null },
      }),
    );
  }).catch((err) => {
    document.dispatchEvent(
      new CustomEvent("dmx-bridge-res", {
        detail: { id, result: null, error: err.message },
      }),
    );
  });
  return; // Don't dispatch synchronous response
}
```

**Performance consideration:** Source map fetching is expensive. Cache aggressively:

- Source maps are cached per bundle URL (already in `sourceMapCache`)
- Component → file resolution could also be cached per component function identity
- For `snapshot --sources`, consider a batch bridge call that resolves all elements at once to avoid fetching the same source map N times

```ts
// Optional: Component-level cache to avoid re-resolving the same function
const componentSourceCache = new WeakMap<Function, { file: string | null; line: number | null }>();
```

**Phase 1.5 deliverables:**

- Source map fetching + VLQ decoder in `main-world-bridge.ts`
- `getReactAncestryWithSources()` — async, tries `_debugSource` first, falls back to source maps
- `normalizeSourcePath()` — strips webpack/turbopack/vite prefixes
- Bundle + source map caching
- Handles inline source maps (`data:` URIs) and external `.map` files

## What We DON'T Do

- **Don't depend on react-grab or bippy** — fiber walking and source map resolution are self-contained
- **Don't bundle source map libraries** — minimal VLQ decoder inline (~50 lines)
- **Don't pollute the page** — bridge script is minimal, uses namespaced event names, cleans up markers
- **Don't fetch source maps unless asked** — only `get-source` and `snapshot --sources` trigger resolution

## Edge Cases

1. **Non-React page**: Bridge returns null → clear error message
2. **Production build without source maps**: Fiber exists but no `_debugSource` and no `.map` files → ancestry has component names but null file/line. Still useful for knowing the component tree.
3. **Production build WITH source maps**: Source map symbolication resolves original file paths — this is the common case for dev/staging and many production builds
4. **Minified component names**: Component names like `t` or `n` → these are still minified even with source maps. Source maps resolve file/line but not display names. Consider using `displayName` hints or the file path itself as the name.
5. **Server components (RSC)**: Client-side fibers only — server components won't appear in ancestry
6. **Multiple React roots**: Fiber walk is per-element, so multiple roots work naturally
7. **ForwardRef / memo wrappers**: Tags 11 and 15 — unwrap to get real component name via `.render` or `.type`
8. **Bundled file paths**: `_debugSource.fileName` may contain webpack/vite prefixes like `webpack:///./src/...` — `normalizeSourcePath()` strips these
9. **CSP restrictions**: If the page has strict CSP that blocks inline scripts, the `<script src>` injection (using `web_accessible_resources`) should still work since it's a file URL, not inline code
10. **Bridge not loaded**: `ensureBridge()` handles lazy injection; timeout after 5s with clear error
11. **Large source maps**: Some bundles have huge `.map` files (10MB+). Consider streaming or partial parsing if this becomes an issue.
12. **Cross-origin source maps**: Some CDN-served bundles may have CORS restrictions on `.map` files. The bridge runs in the page's origin, so same-origin maps are always accessible.
13. **Calling component functions**: The stack trace generation technique calls component functions with fake props — this may have side effects. Use `Error.prepareStackTrace` (V8 API) when available to avoid calling the function. As a safety measure, wrap in a try/catch and set a flag to prevent React state updates.

## Future Enhancements (Bridge-Enabled)

The main world bridge opens up more than just React. Future bridge methods could include:

- **`get-vue-component`**: Access `__vue__` or `__vue_app__` on elements for Vue component info
- **`get-svelte-component`**: Access Svelte's `__svelte_meta` for component source mapping
- **`get-app-state`**: Read application state from Redux, Zustand, Jotai, etc. via window globals
- **`get-page-global`**: Already implemented — read any `window.x.y.z` path
- **`observe-mutations`**: Set up MutationObserver in main world with access to framework internals
- **Component search**: `claudia dominatrix find-component --name "PostCard"` — search by React component name
- **Props inspection**: Read `fiber.memoizedProps` to show component props (useful for debugging state)
