# DOMINATRIX: React Source Mapping (DOM → Component → Source File)

## Goal

Given a `@ref` from a snapshot, return the React component ancestry and source file paths. Enables the workflow:

```
"I see a bug on this button"
  → claudia dominatrix get-source --ref @e35
  → PostEditor.tsx:87 (in PostEditor → DashboardPage → AppLayout)
```

## How It Works

React attaches fiber nodes directly to DOM elements via `__reactFiber$xxx` properties (dev and prod). Each fiber has:

- `.type.displayName` / `.type.name` — component name
- `._debugSource` — `{ fileName, lineNumber }` (dev mode only)
- `.return` — parent fiber (walk up for full ancestry)

We walk the fiber `.return` chain from any DOM element to collect the full component ancestry. **No external dependencies** — works on any React app without react-grab, bippy, or any other library loaded.

### Relationship with react-grab

react-grab remains a separate, complementary tool for **interactive** use — hover to inspect, click to copy, visual overlay. Dominatrix's source mapping is for **programmatic** use by AI agents via CLI.

|                      | react-grab                                 | dominatrix get-source                     |
| -------------------- | ------------------------------------------ | ----------------------------------------- |
| **Use case**         | Interactive — human hovers/clicks elements | Programmatic — AI queries by @ref         |
| **Requires loading** | Yes — script tag or npm import             | No — reads React fiber internals directly |
| **Full ancestry**    | Via clipboard copy                         | Via fiber `.return` walk                  |
| **Source maps**      | bippy resolves bundled→original paths      | Raw `_debugSource` paths (see Edge Cases) |
| **Works without it** | N/A                                        | Yes — zero dependencies on page           |

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

Opt-in flag because it's slower (fiber lookup per element).

## Architecture

```
CLI: claudia dominatrix get-source --ref @e12
  ↓
Gateway: dominatrix.get-source { ref: "@e12" }
  ↓ emit dominatrix.command { action: "get-source", params: { ref: "@e12" } }
Background worker: delegates to content script
  ↓ chrome.tabs.sendMessage
Content script:
  1. resolveRef("@e12") → DOM element
  2. Find __reactFiber$ key on element
  3. Walk fiber.return chain collecting components + _debugSource
  4. Return { component, file, line, ancestry[] }
```

**Zero dependencies**: No react-grab, no bippy, no injection. Just reads what React already puts on the DOM.

## Implementation Plan

### Phase 1: Fiber Walking Utility in Content Script

**File: `clients/dominatrix/src/content-script.ts`**

Add utility functions that access React's fiber tree directly from DOM nodes:

```ts
interface ComponentSource {
  name: string;
  file: string | null;
  line: number | null;
}

/**
 * Find the React fiber attached to a DOM element.
 * React stores fibers as __reactFiber$<random> or __reactInternalInstance$<random>.
 */
function getFiber(element: Element): any | null {
  const fiberKey = Object.keys(element).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
  );
  return fiberKey ? (element as any)[fiberKey] : null;
}

/**
 * Walk the React fiber tree from a DOM element up to the root,
 * collecting component names and source locations.
 *
 * Only includes function components (tag 0) and class components (tag 1),
 * skipping host elements (div, span, etc.) and other fiber types.
 */
function getReactAncestry(element: Element): ComponentSource[] | null {
  const fiber = getFiber(element);
  if (!fiber) return null;

  const ancestry: ComponentSource[] = [];
  let current = fiber;

  while (current) {
    // tag 0 = FunctionComponent, tag 1 = ClassComponent
    if (current.tag === 0 || current.tag === 1) {
      const name = current.type?.displayName || current.type?.name || null;
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
```

**Fiber tag reference** (for filtering):

- `0` — FunctionComponent
- `1` — ClassComponent
- `5` — HostComponent (div, span — skip these)
- `3` — HostRoot (root of tree — stop here)
- `11` — ForwardRef (include — wraps real components)
- `15` — SimpleMemoComponent (include — wraps real components)

Consider also including tags 11 and 15 if the wrapped component name is meaningful.

### Phase 2: `get-source` Message Handler

**File: `clients/dominatrix/src/content-script.ts`**

Add to the message switch:

```ts
case "get-source": {
  const el = resolveElement(message.ref, message.selector);
  if (!el) throw new Error("Element not found");

  const ancestry = getReactAncestry(el);

  if (!ancestry) {
    // Check if this is a React app at all
    const hasReactFiber = Object.keys(el).some(
      k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (!hasReactFiber) {
      throw new Error("No React fiber found on this element (not a React app, or production build with fibers stripped)");
    }
    throw new Error("Could not resolve React component for this element");
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

`resolveElement` helper (shared with click/fill):

```ts
function resolveElement(ref?: string, selector?: string): Element | null {
  if (ref) return resolveRef(ref);
  if (selector) return document.querySelector(selector);
  return null;
}
```

### Phase 3: Enriched Snapshot with Sources

**File: `clients/dominatrix/src/content-script.ts`**

Update `getInteractiveSnapshot()` to accept a `sources` flag:

```ts
function getInteractiveSnapshot(scope?: string, sources?: boolean): string {
  // ... existing snapshot logic ...

  for (const element of interactiveElements) {
    const ref = nextRef();
    refMap.set(ref, element);
    let line = formatRefLine(ref, element);

    if (sources) {
      const ancestry = getReactAncestry(element);
      if (ancestry && ancestry.length > 0) {
        const nearest = ancestry[0];
        const shortFile = nearest.file?.replace(/^.*?\/src\//, "src/") || "";
        const chain = ancestry
          .slice(1, 3)
          .map((c) => c.name)
          .join(" → ");
        line += ` <- ${nearest.name}`;
        if (shortFile) line += ` (${shortFile}${nearest.line ? `:${nearest.line}` : ""})`;
        if (chain) line += ` → ${chain}`;
      }
    }

    lines.push(line);
  }
  // ...
}
```

Update the snapshot message handler:

```ts
case "snapshot":
  result = message.full
    ? getFullSnapshot()
    : getInteractiveSnapshot(message.scope, message.sources);
  break;
```

### Phase 4: Gateway Extension Updates

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

### Phase 5: Skill Documentation

**File: `~/.claude/skills/controlling-the-browser/SKILL.md`**

Add section on source mapping:

````markdown
## React Source Mapping

Map DOM elements back to React component source files. Works on any React dev app — no additional libraries needed.

### Commands

```bash
# Get source for a specific element
claudia dominatrix get-source --ref @e12
# Returns: component name, file path, line number, full ancestry chain

# Enriched snapshot with source annotations
claudia dominatrix snapshot --sources
# Each element shows its nearest React component + file path
```
````

### Workflow: UI bug → source file

1. `claudia dominatrix snapshot --sources` — see elements with component names
2. Identify the problematic element by its ref
3. `claudia dominatrix get-source --ref @eN` — get full ancestry chain
4. Open the source file and fix the issue

### Requirements

- React app running in **dev mode** (source info comes from `_debugSource`, stripped in prod)
- No additional libraries needed — reads React fiber internals directly from DOM

```

## Files to Modify

| File | Changes |
|---|---|
| `clients/dominatrix/src/content-script.ts` | `getFiber()`, `getReactAncestry()`, `get-source` handler, `sources` flag in snapshot |
| `extensions/dominatrix/src/index.ts` | `dominatrix.get-source` method + schema, `sources` param on snapshot schema |
| `~/.claude/skills/controlling-the-browser/SKILL.md` | Document source mapping commands |

## What We DON'T Do

- **Don't depend on react-grab or bippy** — fiber walking uses only React's own DOM properties
- **Don't inject anything** into pages — reads existing state
- **Don't bundle any libraries** — zero external dependencies
- **Don't try to work on production builds** — graceful error (names may be minified, `_debugSource` stripped)

## Edge Cases

1. **Non-React page**: `getFiber()` returns null → clear error "No React fiber found"
2. **Production build**: Fiber exists but `_debugSource` is stripped → ancestry has component names but null file/line. Still useful for knowing the component tree.
3. **Minified production names**: Component names like `t` or `n` → warn user to use dev mode
4. **Server components (RSC)**: Client-side fibers only — server components won't appear in ancestry. This is fine; we only care about what's rendered on the client.
5. **Multiple React roots**: Fiber walk is per-element, so multiple roots work naturally
6. **ForwardRef / memo wrappers**: Tags 11 and 15 — include if the wrapped component has a meaningful name
7. **Bundled file paths**: `_debugSource.fileName` may contain webpack/vite prefixes like `webpack:///./src/...` — strip common prefixes for cleaner output

## Future Enhancements

- **Path normalization**: Strip bundler prefixes (`webpack:///`, `/@fs/`, etc.) from `_debugSource.fileName` for cleaner output
- **Component search**: `claudia dominatrix find-component --name "PostCard"` — search by React component name instead of DOM attributes
- **react-grab plugin**: If react-grab is present, register a dominatrix plugin for "Send to Claude" action from the hover overlay
- **Props inspection**: Read `fiber.memoizedProps` to show component props (useful for debugging state)
```
