# DOMINATRIX: Snapshot Refs & Agent-Friendly Interaction

## Problem

Currently, interacting with page elements from the CLI requires:

1. Running `claudia dominatrix snapshot` → get 500KB+ JSON a11y tree
2. Grepping through it to find the right element
3. Guessing a CSS selector for `click`/`fill`
4. Often failing because the selector doesn't match or hits the wrong element (e.g., clicking a `<span>` instead of its parent `<a>`)

This is unusable for AI agents. We need the `agent-browser` interaction model: **snapshot → ref → act → re-snapshot**.

## Solution

Port the ref-based snapshot system from [agent-browser](~/Projects/oss/vercel-labs/agent-browser/src/snapshot.ts) into the dominatrix content script. Since we can't use Playwright's proprietary `ariaSnapshot()`, we build our own DOM walker.

## Architecture

```
Current:
  CLI → gateway → background.ts → content-script.ts → full a11y tree JSON (huge)
  CLI → gateway → background.ts → content-script.ts → querySelector(css) → click (fragile)

Proposed:
  CLI → gateway → background.ts → content-script.ts → compact ref list (small)
  CLI → gateway → background.ts → content-script.ts → refMap[@e2] → element → click (reliable)
```

The content script maintains a `refMap: Map<string, Element>` that maps `@e1`, `@e2`, etc. directly to DOM element references. This is simpler than agent-browser's approach (which stores selectors and re-queries) because we have persistent content script state.

## Commands (New & Updated)

All commands follow the gateway convention: `dominatrix.method-name` with explicit named params via zod schemas. The CLI maps these as `claudia dominatrix method-name --param value`.

### Snapshot & Page Info

```bash
# Interactive snapshot with refs (NEW — the main addition)
claudia dominatrix snapshot              # Interactive elements with @refs (new default)
claudia dominatrix snapshot --full       # Full a11y tree JSON (old behavior)
claudia dominatrix snapshot --scope "#main"  # Scope to CSS selector

# Getters (renamed from text/markdown for consistency)
claudia dominatrix get-text              # Page innerText (was: text)
claudia dominatrix get-text --ref @e5    # Text of specific element
claudia dominatrix get-markdown          # Page as Markdown (was: markdown)
claudia dominatrix get-url               # Current URL
claudia dominatrix get-title             # Page title
claudia dominatrix get-html              # Full page HTML (was: html)
claudia dominatrix get-html --selector "div.main"  # Scoped HTML
```

**Gateway methods:**

| Method                    | Schema              | Description                             |
| ------------------------- | ------------------- | --------------------------------------- |
| `dominatrix.snapshot`     | `{ full?, scope? }` | Interactive refs (default) or full tree |
| `dominatrix.get-text`     | `{ ref? }`          | Plain text of page or element           |
| `dominatrix.get-markdown` | `{ ref? }`          | Markdown of page or element             |
| `dominatrix.get-url`      | `{}`                | Current page URL                        |
| `dominatrix.get-title`    | `{}`                | Current page title                      |
| `dominatrix.get-html`     | `{ selector? }`     | HTML of page or element                 |

### Interaction (ref-based)

```bash
# Click — supports @ref (preferred) or --selector fallback
claudia dominatrix click --ref @e3                    # Click "Posts" link
claudia dominatrix click --selector "button.submit"   # CSS fallback

# Fill form fields
claudia dominatrix fill --ref @e10 --value "hello"
claudia dominatrix fill --selector "input[name=email]" --value "user@example.com"

# Checkbox / radio
claudia dominatrix check --ref @e7
claudia dominatrix uncheck --ref @e7

# Select dropdown
claudia dominatrix select --ref @e5 --value "option-1"
```

**Gateway methods:**

| Method               | Schema                       | Description            |
| -------------------- | ---------------------------- | ---------------------- |
| `dominatrix.click`   | `{ ref?, selector? }`        | Click element          |
| `dominatrix.fill`    | `{ ref?, selector?, value }` | Fill form field        |
| `dominatrix.check`   | `{ ref?, selector? }`        | Check checkbox         |
| `dominatrix.uncheck` | `{ ref?, selector? }`        | Uncheck checkbox       |
| `dominatrix.select`  | `{ ref?, selector?, value }` | Select dropdown option |

### Semantic Find (NEW)

Find elements by semantic attributes and perform actions. Each `find-*` method locates the element and executes an action in one call.

```bash
claudia dominatrix find-text --text "Posts" --action click
claudia dominatrix find-text --text "Email" --action fill --value "user@example.com"
claudia dominatrix find-label --label "Password" --action fill --value "secret"
claudia dominatrix find-role --role button --name "Submit" --action click
claudia dominatrix find-placeholder --placeholder "Search..." --action fill --value "query"
```

**Gateway methods:**

| Method                        | Schema                            | Description              |
| ----------------------------- | --------------------------------- | ------------------------ |
| `dominatrix.find-text`        | `{ text, action, value? }`        | Find by visible text     |
| `dominatrix.find-label`       | `{ label, action, value? }`       | Find by label/aria-label |
| `dominatrix.find-role`        | `{ role, name?, action, value? }` | Find by ARIA role        |
| `dominatrix.find-placeholder` | `{ placeholder, action, value? }` | Find by placeholder      |

### Navigation & Scrolling

```bash
# Navigate
claudia dominatrix navigate --url "https://example.com"

# Scroll
claudia dominatrix scroll-down --value 500     # Scroll down 500px (default: 300)
claudia dominatrix scroll-up --value 300        # Scroll up
claudia dominatrix scroll-to --ref @e5          # Scroll element into view
claudia dominatrix scroll-to --position top     # Scroll to top
claudia dominatrix scroll-to --position bottom  # Scroll to bottom
```

**Gateway methods:**

| Method                   | Schema                | Description                   |
| ------------------------ | --------------------- | ----------------------------- |
| `dominatrix.navigate`    | `{ url }`             | Navigate tab to URL           |
| `dominatrix.scroll-down` | `{ value? }`          | Scroll down by pixels         |
| `dominatrix.scroll-up`   | `{ value? }`          | Scroll up by pixels           |
| `dominatrix.scroll-to`   | `{ ref?, position? }` | Scroll to element or position |

### Wait (NEW)

```bash
claudia dominatrix wait-for-element --selector "div.loaded"  # Wait for element
claudia dominatrix wait-for-text --text "Success"            # Wait for text to appear
claudia dominatrix wait-for-url --pattern "**/posts"         # Wait for URL change
claudia dominatrix wait --ms 2000                            # Wait milliseconds
```

**Gateway methods:**

| Method                        | Schema                   | Description      |
| ----------------------------- | ------------------------ | ---------------- |
| `dominatrix.wait-for-element` | `{ selector, timeout? }` | Wait for element |
| `dominatrix.wait-for-text`    | `{ text, timeout? }`     | Wait for text    |
| `dominatrix.wait-for-url`     | `{ pattern, timeout? }`  | Wait for URL     |
| `dominatrix.wait`             | `{ ms }`                 | Wait fixed time  |

### Debugging (existing, renamed)

```bash
claudia dominatrix exec --script "document.title = 'hi'"    # Execute JS (unchanged)
claudia dominatrix eval --expression "document.title"        # Evaluate JS (unchanged)
claudia dominatrix get-console                               # Console logs (was: console)
claudia dominatrix get-network                               # Network requests (was: network)
claudia dominatrix get-storage                               # localStorage/sessionStorage (was: storage)
claudia dominatrix get-cookies                               # Cookies (was: cookies)
claudia dominatrix screenshot                                # Screenshot (unchanged)
```

### Snapshot Output Format

The default `snapshot` (interactive mode) returns compact text:

```
Page: beehiiv Dashboard
URL: https://app.beehiiv.com/dashboard

@e1 [a] "Dashboard"
@e2 [a] "Start writing"
@e3 [a] "Posts"
@e4 [a] "Audience"
@e5 [a] "Grow"
@e6 [a] "Monetize"
@e7 [button] "View site"
@e8 [input type="email"] placeholder="Enter email"
@e9 [button] "Submit"
@e10 [clickable] "Copy" (cursor:pointer)
```

This is ~200-400 tokens vs ~50,000+ for the full a11y tree JSON.

## Implementation Plan

### Phase 0: Resilient Content Script Injection

**Problem**: `chrome.tabs.sendMessage()` fails with "Could not establish connection" when the content script hasn't loaded yet — happens on manual navigation, new tabs, or page reloads before `document_idle`.

**Fix**: Add `chrome.scripting.executeScript()` fallback in the background worker.

**File: `clients/dominatrix/src/background.ts`**

1. Add `scripting` permission to `manifest.json` (if not already present)
2. Wrap all `chrome.tabs.sendMessage()` calls with a resilient dispatcher:

```ts
async function sendToContentScript(tabId: number, message: any): Promise<any> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // Content script not loaded — inject it on demand
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"],
    });
    // Brief delay for script initialization
    await new Promise((resolve) => setTimeout(resolve, 100));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}
```

3. Content script should be idempotent — guard against double-injection:

```ts
// content-script.ts — top of file
if (window.__dominatrix_loaded) {
  // Already injected, skip initialization
} else {
  window.__dominatrix_loaded = true;
  // ... initialize console hooks, message listeners, etc.
}
```

4. Replace all direct `chrome.tabs.sendMessage()` calls in `background.ts` with `sendToContentScript()`

**Why not CDP?** Using `chrome.debugger` would work but shows an ugly yellow "this browser is being debugged" banner. The `executeScript` fallback is invisible to the user and handles all the failure cases we hit (navigating to beehiiv, page reloads, new tabs).

### Phase 1: Ref System in Content Script

**File: `clients/dominatrix/src/content-script.ts`**

Add:

1. `refMap: Map<string, Element>` — maps ref IDs to DOM elements
2. `refCounter: number` — sequential counter, resets on each snapshot
3. `getInteractiveSnapshot()` — walks DOM, builds ref list, returns compact text
4. `resolveRef(ref: string): Element | null` — looks up element from refMap
5. `getImplicitRole(element: Element): string` — determines ARIA role from tag name
6. `findCursorInteractiveElements()` — adapted from agent-browser's `snapshot.ts:161-256`

### Phase 2: Updated Message Handlers in Content Script

**File: `clients/dominatrix/src/content-script.ts`**

Update/add message handlers to match new gateway actions:

1. `snapshot` → return interactive refs by default, `--full` for old JSON tree
2. `click` → resolve `ref` OR `selector`, with ancestor walking for refs
3. `fill` → resolve `ref` OR `selector`, proper event dispatching (focus → clear → input → change)
4. New handlers: `check`, `uncheck`, `select`
5. New handlers: `find-text`, `find-label`, `find-role`, `find-placeholder` (locate + act)
6. New handlers: `scroll-down`, `scroll-up`, `scroll-to`
7. New handlers: `wait-for-element`, `wait-for-text`, `wait-for-url`, `wait`
8. Rename existing: `getText` → `get-text`, `getMarkdown` → `get-markdown`, etc.
9. New handlers: `get-url`, `get-title` (trivial — `location.href`, `document.title`)

### Phase 3: Gateway Extension Updates

**File: `extensions/dominatrix/src/index.ts`**

Update method definitions and schemas to match the new flat `dominatrix.method-name` convention:

1. **Update existing methods:**
   - `dominatrix.snapshot` — add `full` boolean, `scope` string params
   - `dominatrix.click` — add `ref` string param alongside `selector`
   - `dominatrix.fill` — add `ref` string param alongside `selector`
   - Rename: `dominatrix.text` → `dominatrix.get-text`, etc.

2. **Add new methods (with zod schemas):**
   - `dominatrix.get-url`, `dominatrix.get-title`
   - `dominatrix.check`, `dominatrix.uncheck`, `dominatrix.select`
   - `dominatrix.find-text`, `dominatrix.find-label`, `dominatrix.find-role`, `dominatrix.find-placeholder`
   - `dominatrix.scroll-down`, `dominatrix.scroll-up`, `dominatrix.scroll-to`
   - `dominatrix.wait-for-element`, `dominatrix.wait-for-text`, `dominatrix.wait-for-url`, `dominatrix.wait`

3. **Update `sendCommand` routing** — map method names to content script actions

No CLI changes needed — the CLI is auto-generated from zod schemas.

### Phase 4: react-grab Integration (DOM → React Source Mapping)

**Goal**: Given a `@ref` from a snapshot, return the React component name and source file path. Enables the workflow: "I see a bug on this button" → `get-source --ref @e35` → `PostEditor.tsx:87`.

**Prerequisites**: The target app must load react-grab in dev mode (script tag, npm import, or `<ReactGrab />` component). Dominatrix does NOT bundle react-grab — it just consumes the API that react-grab exposes on the page.

**How it works**:

1. App loads react-grab → installs `window.__REACT_GRAB__` API
2. User runs `claudia dominatrix get-source --ref @e35`
3. Content script resolves `@e35` → DOM element from refMap
4. Calls `window.__REACT_GRAB__.getSource(element)`
5. Returns `{ filePath, lineNumber, componentName }`

**What react-grab gives us** (from clipboard output):

```
@<Card>
<div class="border group/ui...">
  ...
  in Card (at /ui/Card/Card.tsx)
  in ChartAreaInteractive (at /src/routes/dashboard/components/SubscriberEventsWidget/SubscriberEventsWidget.tsx)
  in AnalyticsSection (at /src/routes/dashboard/components/AnalyticsSection/AnalyticsSection.tsx)
```

It returns the **full component ancestry chain** — from the immediate wrapper up through the page section. This is critical for knowing whether to fix the UI primitive or the feature component.

**New command**:

```bash
claudia dominatrix get-source --ref @e12
# → {
#   "components": [
#     { "name": "Card", "file": "/ui/Card/Card.tsx" },
#     { "name": "ChartAreaInteractive", "file": "/src/routes/dashboard/components/SubscriberEventsWidget/SubscriberEventsWidget.tsx" },
#     { "name": "AnalyticsSection", "file": "/src/routes/dashboard/components/AnalyticsSection/AnalyticsSection.tsx" }
#   ]
# }

claudia dominatrix get-source --selector ".my-button"
# → same, but via CSS selector

# Bulk: get source for all interactive elements (enriched snapshot)
claudia dominatrix snapshot --sources
# → @e1 [button] "Submit" ← Card → ChartAreaInteractive (SubscriberEventsWidget.tsx) → AnalyticsSection
# → @e2 [a] "Dashboard" ← NavLink (Sidebar.tsx)
```

**Gateway method**:

| Method                  | Schema                | Description                              |
| ----------------------- | --------------------- | ---------------------------------------- |
| `dominatrix.get-source` | `{ ref?, selector? }` | Get React component ancestry for element |

**Content script handler** (`get-source` action):

```ts
case "get-source": {
  const el = resolveElement(message.ref, message.selector);
  if (!window.__REACT_GRAB__) {
    return { success: false, error: "react-grab not loaded on this page (dev mode only)" };
  }
  // copyElement returns the full ancestry text that react-grab puts on clipboard
  // We can parse it or use getSource/getDisplayName to walk the fiber tree
  const source = await window.__REACT_GRAB__.getSource(el);
  const name = window.__REACT_GRAB__.getDisplayName(el);
  // TODO: Need to check if react-grab API exposes full ancestry or just nearest component.
  // If only nearest, we may need to use bippy's getFiberFromHostInstance() and walk
  // fiber.return chain ourselves to build the full ancestry.
  return {
    success: true,
    data: {
      componentName: name || null,
      filePath: source?.filePath || null,
      lineNumber: source?.lineNumber || null,
      // Full ancestry if available:
      // components: [{ name, file }, ...]
    }
  };
}
```

**Note**: The `getSource()` API may only return the nearest component. The full ancestry chain (as seen in the clipboard output) might require walking the React fiber tree via bippy's `getFiberFromHostInstance()` → traverse `fiber.return` chain → collect composite fiber names + `_debugSource` at each level. We should test what the API exposes and fall back to fiber walking if needed.

**Snapshot `--sources` flag**: When set, after building the ref list, iterate each ref's element and call `getSource()` to append source info to the output line. Show the nearest meaningful component name (skip generic primitives like `div`, `span`). This is slower (one async call per element) so it's opt-in.

**What we DON'T do**:

- Don't bundle react-grab in the extension
- Don't inject react-grab into pages
- Don't touch the react-grab UI (user keeps the hover overlay for manual use)
- Don't try to work on production builds (graceful "not available" error)

**Files to modify**:

- `clients/dominatrix/src/content-script.ts` — add `get-source` handler, optional source enrichment in snapshot
- `extensions/dominatrix/src/index.ts` — add `dominatrix.get-source` method + schema, update `dominatrix.snapshot` schema with `sources` boolean

### Phase 5: Controlling-the-Browser Skill Update

**File: `~/.claude/skills/controlling-the-browser/SKILL.md`**

Rewrite to document the new ref-based workflow:

```bash
# Core workflow: snapshot → ref → act → re-snapshot
claudia dominatrix snapshot                    # Get interactive elements with @refs
claudia dominatrix click --ref @e3             # Click by ref
claudia dominatrix fill --ref @e10 --value "text"  # Fill by ref
claudia dominatrix snapshot                    # Re-snapshot after interaction
```

## Key Design Decisions

### Direct Element References vs Stored Selectors

Unlike agent-browser (which stores selectors and re-queries), we store **direct DOM element references** in the content script. This is:

- **Faster**: No re-querying
- **More reliable**: No selector ambiguity
- **Simpler**: No need for nth disambiguation

**Tradeoff**: Refs are invalidated when the page navigates or content script reloads. Same as agent-browser — re-snapshot after navigation.

### Implicit Role Mapping

Since we don't have Playwright's `ariaSnapshot()`, we need our own role inference:

```
<a>        → link
<button>   → button
<input>    → textbox (or checkbox, radio, etc. based on type)
<select>   → combobox
<textarea> → textbox
<details>  → group
<summary>  → button
[role="x"] → x (explicit always wins)
```

### Ancestor Walking for Clicks

When clicking `@e3` which points to a `<span>`, walk up to find the nearest interactive ancestor (`<a>`, `<button>`, or element with `onclick`/`role="button"`). This fixes the beehiiv "Posts" click issue.

### Ref Output Format

Follow agent-browser's compact format:

```
@e1 [tag] "visible text"
@e2 [input type="email"] placeholder="Enter email"
@e3 [button] "Submit"
```

This is ~200-400 tokens vs ~50,000+ tokens for the full a11y tree JSON.

## Files to Modify

| File                                                | Changes                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `clients/dominatrix/manifest.json`                  | Add `scripting` permission                                              |
| `clients/dominatrix/src/background.ts`              | Resilient `sendToContentScript()` dispatcher                            |
| `clients/dominatrix/src/content-script.ts`          | Idempotent init guard, ref system, DOM walker, all new/updated handlers |
| `extensions/dominatrix/src/index.ts`                | New method schemas (zod), method routing, renamed methods               |
| `~/.claude/skills/controlling-the-browser/SKILL.md` | Rewrite for ref-based workflow                                          |

Note: CLI is auto-generated from zod schemas — no separate CLI changes needed.

## Reference

- agent-browser snapshot.ts: `~/Projects/oss/vercel-labs/agent-browser/src/snapshot.ts`
- agent-browser commands ref: `~/.claude/skills/browsing-the-web/references/commands.md`
- agent-browser snapshot ref: `~/.claude/skills/browsing-the-web/references/snapshot-refs.md`
- react-grab: `https://github.com/aidenybai/react-grab`
- react-grab API: `window.__REACT_GRAB__` — `getSource(element)`, `getDisplayName(element)`
- bippy (react-grab core): `https://github.com/nicholasgasior/bippy` — lightweight React fiber access
