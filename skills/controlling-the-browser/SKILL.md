---
name: controlling-the-browser
description: "MUST be used when you need to control the user's real Chrome browser — inspect pages, take screenshots, click elements, fill forms, read content, or execute JavaScript on live tabs with existing auth and cookies. Uses DOMINATRIX browser control through Claudia's gateway extension. Triggers on: control browser, inspect page, browser automation, chrome tab, read page content, get page text, page screenshot, DOM snapshot, fill form in browser, click in browser, browser cookies, console logs, network requests, control tab, dominatrix."
allowed-tools: Bash(claudia dominatrix:*)
---

# Browser Control with DOMINATRIX

Control the user's real Chrome browser — live tabs with existing auth, cookies, and profiles. Unlike headless automation (agent-browser), this controls the actual browser the user has open.

## When to Use This vs browsing-the-web

| This skill (controlling-the-browser) | browsing-the-web (agent-browser)      |
| ------------------------------------ | ------------------------------------- |
| Control user's real Chrome tabs      | Headless/isolated Playwright browser  |
| Existing auth, cookies, sessions     | Clean sessions, state files           |
| Inspect what user is looking at      | Automate new browsing tasks           |
| Debug live pages                     | Scrape, test, fill forms from scratch |

## Core Workflow: Snapshot → Ref → Act → Re-snapshot

```bash
# 1. Take a snapshot to get interactive elements with @refs
claudia dominatrix snapshot

# Output:
# Page: beehiiv Dashboard
# URL: https://app.beehiiv.com/dashboard
#
# @e1 [a] "Dashboard" href="/dashboard"
# @e2 [a] "Start writing" href="/posts/new"
# @e3 [a] "Posts" href="/posts"
# @e4 [button] "View site"
# @e5 [input type="email"] placeholder="Enter email"
# @e6 [button] "Submit"

# 2. Interact using @refs (reliable, no CSS selector guessing)
claudia dominatrix click --ref @e3              # Click "Posts" link
claudia dominatrix fill --ref @e5 --value "user@example.com"  # Fill email

# 3. Re-snapshot after navigation/interaction (refs are invalidated)
claudia dominatrix snapshot
```

**Key principle**: Always snapshot before interacting. Refs are invalidated on page navigation or dynamic changes — re-snapshot to get fresh refs.

## Commands

All commands go through `claudia dominatrix <method>`. When `--tab-id` is omitted, the active tab is used.

### Snapshot & Page Info

```bash
# Interactive snapshot with @refs (DEFAULT — use this!)
claudia dominatrix snapshot
claudia dominatrix snapshot --full        # Full a11y tree JSON (old behavior, large)
claudia dominatrix snapshot --scope "#main"  # Scope to CSS selector

# Content extraction
claudia dominatrix get-text               # Page innerText (plain text, most efficient)
claudia dominatrix get-text --ref @e5     # Text of specific element
claudia dominatrix get-markdown           # Page as Markdown
claudia dominatrix get-markdown --ref @e5 # Markdown of specific element
claudia dominatrix get-url                # Current URL
claudia dominatrix get-title              # Page title
claudia dominatrix get-html               # Full page HTML
claudia dominatrix get-html --selector "div.main"  # Scoped HTML
```

### Interaction (ref-based — preferred)

```bash
# Click — use @ref (preferred) or --selector fallback
claudia dominatrix click --ref @e3
claudia dominatrix click --selector "button.submit"

# Fill form fields
claudia dominatrix fill --ref @e10 --value "hello"
claudia dominatrix fill --selector "input[name=email]" --value "user@example.com"

# Checkbox / radio
claudia dominatrix check --ref @e7
claudia dominatrix uncheck --ref @e7

# Select dropdown
claudia dominatrix select --ref @e5 --value "option-1"
```

### Semantic Find (locate + act in one call)

```bash
claudia dominatrix find-text --text "Posts" --perform click
claudia dominatrix find-text --text "Email" --perform fill --value "user@example.com"
claudia dominatrix find-label --label "Password" --perform fill --value "secret"
claudia dominatrix find-role --role button --name "Submit" --perform click
claudia dominatrix find-placeholder --placeholder "Search..." --perform fill --value "query"
```

### Navigation & Scrolling

```bash
claudia dominatrix navigate --url "https://example.com"

claudia dominatrix scroll-down --value 500      # Scroll down 500px (default: 300)
claudia dominatrix scroll-up --value 300         # Scroll up
claudia dominatrix scroll-to --ref @e5           # Scroll element into view
claudia dominatrix scroll-to --position top      # Scroll to top
claudia dominatrix scroll-to --position bottom   # Scroll to bottom
```

### Wait

```bash
claudia dominatrix wait-for-element --selector "div.loaded"  # Wait for element
claudia dominatrix wait-for-text --text "Success"            # Wait for text to appear
claudia dominatrix wait-for-url --pattern "**/posts"         # Wait for URL change
claudia dominatrix wait --ms 2000                            # Wait milliseconds
```

### Debugging

```bash
claudia dominatrix exec --script "document.title = 'hi'"     # Execute JS
claudia dominatrix eval --expression "document.title"         # Evaluate JS
claudia dominatrix get-console                                # Console logs
claudia dominatrix get-network                                # Network requests
claudia dominatrix get-storage                                # localStorage/sessionStorage
claudia dominatrix get-cookies                                # Cookies
claudia dominatrix screenshot                                 # Screenshot as PNG data URL
```

## Content Reading Strategy

| Method            | When to use                                        | Output size     |
| ----------------- | -------------------------------------------------- | --------------- |
| `snapshot`        | **Default** — find interactive elements with @refs | ~200-400 tokens |
| `get-text`        | Quick content reading, search results              | Medium          |
| `get-markdown`    | Structured content (articles, docs)                | Medium          |
| `snapshot --full` | Deep DOM inspection (rarely needed)                | ~50,000+ tokens |
| `get-html`        | Specific element inspection                        | Variable        |
| `screenshot`      | Visual verification, layout issues                 | PNG data URL    |

## Ref Lifecycle

- Refs (`@e1`, `@e2`, ...) map directly to DOM element references in the content script
- **Invalidated** when the page navigates or content changes significantly
- Always re-snapshot after: clicking links, submitting forms, or waiting for dynamic content
- The ancestor walking system handles cases like clicking a `<span>` inside an `<a>` — it finds the nearest interactive parent automatically

## Notes

- **Real browser**: Controls actual Chrome with real profiles, cookies, and auth — not sandboxed
- **CSP bypass**: Script execution uses JailJS (AST interpreter) for sites with strict CSP
- **Resilient injection**: If the content script isn't loaded (page reload, manual navigation), it's automatically injected on demand
- **Console/Network**: Collected passively from content script load — retrieve history anytime
- **Side panel context**: When the Claudia side panel is open, commands without `--tab-id` target that tab
