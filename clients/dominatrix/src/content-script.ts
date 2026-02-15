/**
 * DOMINATRIX Content Script
 *
 * Runs in web page context with DOM access.
 * Handles: ref-based snapshots, interaction (click/fill/check/select),
 * semantic find, content extraction, script execution, storage access,
 * scrolling, waiting, and console interception.
 *
 * The ref system maps short IDs (@e1, @e2, ...) directly to DOM element
 * references for reliable, agent-friendly interaction.
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { Interpreter, parse } from "@mariozechner/jailjs";

// Idempotent guard — prevent double-injection from executeScript fallback
if ((window as any).__dominatrix_loaded) {
  // Already injected, skip initialization
} else {
  (window as any).__dominatrix_loaded = true;
  initDominatrix();
}

function initDominatrix() {
  // ==========================================================================
  // Types
  // ==========================================================================

  interface DOMNode {
    uid: string;
    role: string;
    tagName: string;
    name: string;
    classList?: string[];
    attributes?: Record<string, string>;
    children?: DOMNode[];
  }

  interface ConsoleLogEntry {
    id: string;
    type: "log" | "info" | "warn" | "error" | "debug";
    message: string;
    args: unknown[];
    timestamp: number;
    url: string;
  }

  // ==========================================================================
  // Ref system state
  // ==========================================================================

  let refMap = new Map<string, Element>();
  let refCounter = 0;

  function nextRef(): string {
    return `@e${++refCounter}`;
  }

  function resetRefs() {
    refMap.clear();
    refCounter = 0;
  }

  function resolveRef(ref: string): Element | null {
    // Accept both "@e3" and "e3"
    const key = ref.startsWith("@") ? ref : `@${ref}`;
    return refMap.get(key) || null;
  }

  // ==========================================================================
  // Main world bridge client (for React fiber access, page globals, etc.)
  // ==========================================================================

  let bridgePromise: Promise<void> | null = null;
  let bridgeCallId = 0;

  /**
   * Inject the main world bridge script and wait for it to load.
   * Returns a cached promise — safe to call multiple times.
   * The bridge runs in the page's MAIN world where React fibers are visible.
   */
  function ensureBridge(): Promise<void> {
    if (bridgePromise) return bridgePromise;

    bridgePromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("main-world-bridge.js");
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = () => {
        script.remove();
        bridgePromise = null; // Allow retry on next call
        reject(new Error("Failed to load main world bridge script"));
      };
      (document.head || document.documentElement).appendChild(script);
    });

    return bridgePromise;
  }

  async function callBridge(method: string, detail: Record<string, any> = {}): Promise<any> {
    await ensureBridge();
    const id = `dmx-${++bridgeCallId}`;

    return new Promise((resolve, reject) => {
      const handler = (e: Event) => {
        const ce = e as CustomEvent;
        if (ce.detail.id !== id) return;
        document.removeEventListener("dmx-bridge-res", handler);
        if (ce.detail.error) reject(new Error(ce.detail.error));
        else resolve(ce.detail.result);
      };
      document.addEventListener("dmx-bridge-res", handler);

      document.dispatchEvent(
        new CustomEvent("dmx-bridge-req", {
          detail: { id, method, ...detail },
        }),
      );

      setTimeout(() => {
        document.removeEventListener("dmx-bridge-res", handler);
        reject(new Error(`Bridge call timed out: ${method}`));
      }, 5000);
    });
  }

  function callBridgeForElement(method: string, element: Element): Promise<any> {
    const marker = `dmx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    element.setAttribute("data-dmx-target", marker);
    const promise = callBridge(method, { selector: `[data-dmx-target="${marker}"]` });
    // Clean up marker after bridge reads it (next frame)
    promise.finally(() => {
      requestAnimationFrame(() => element.removeAttribute("data-dmx-target"));
    });
    return promise;
  }

  // ==========================================================================
  // Interpreter (JailJS for CSP bypass)
  // ==========================================================================

  const interpreter = new Interpreter(
    {
      document,
      window,
      console,
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      fetch,
      JSON,
      Math,
      Date,
    },
    { maxOps: 1_000_000 },
  );

  // ==========================================================================
  // Constants
  // ==========================================================================

  const IMPORTANT_ATTRS = new Set([
    "id",
    "name",
    "type",
    "href",
    "src",
    "alt",
    "title",
    "placeholder",
    "value",
    "aria-label",
    "data-testid",
  ]);

  const ROLE_MAP: Record<string, string> = {
    a: "link",
    button: "button",
    textarea: "textbox",
    select: "combobox",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    article: "article",
    section: "region",
    aside: "complementary",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    ul: "list",
    ol: "list",
    li: "listitem",
    table: "table",
    form: "form",
    details: "group",
    summary: "button",
  };

  const INTERACTIVE_TAGS = new Set([
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "details",
    "summary",
  ]);

  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "treeitem",
  ]);

  // ==========================================================================
  // Message router
  // ==========================================================================

  chrome.runtime.onMessage.addListener(
    (
      message: { action: string; [key: string]: any },
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      (async () => {
        try {
          let result: unknown;
          switch (message.action) {
            // --- Snapshot & page info ---
            case "snapshot":
              result = message.full
                ? getFullSnapshot()
                : await getInteractiveSnapshot(message.scope, message.sources);
              break;
            case "get-text":
              result = message.ref ? getElementText(message.ref) : getText();
              break;
            case "get-markdown":
              result = message.ref ? getElementMarkdown(message.ref) : getMarkdown();
              break;
            case "get-url":
              result = location.href;
              break;
            case "get-title":
              result = document.title;
              break;
            case "get-html":
              result = getHTML(message.selector);
              break;

            // --- React source mapping (via main world bridge) ---
            case "get-source": {
              const el = resolveElement(message.ref, message.selector);
              const ancestry = await callBridgeForElement("get-react-ancestry", el);

              if (!ancestry || ancestry.length === 0) {
                throw new Error(
                  "No React component found for this element. " +
                    "Possible causes: not a React app, production build, or element is a plain HTML node.",
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

            // --- Interaction (ref-based) ---
            case "click":
              result = doClick(message.ref, message.selector);
              break;
            case "fill":
              result = doFill(message.ref, message.selector, message.value);
              break;
            case "check":
              result = doCheck(message.ref, message.selector, true);
              break;
            case "uncheck":
              result = doCheck(message.ref, message.selector, false);
              break;
            case "select":
              result = doSelect(message.ref, message.selector, message.value);
              break;

            // --- Semantic find ---
            case "find-text":
              result = findByText(message.text, message.perform, message.value);
              break;
            case "find-label":
              result = findByLabel(message.label, message.perform, message.value);
              break;
            case "find-role":
              result = findByRole(message.role, message.name, message.perform, message.value);
              break;
            case "find-placeholder":
              result = findByPlaceholder(message.placeholder, message.perform, message.value);
              break;

            // --- Scrolling ---
            case "scroll-down":
              window.scrollBy(0, message.value || 300);
              result = { scrollY: window.scrollY };
              break;
            case "scroll-up":
              window.scrollBy(0, -(message.value || 300));
              result = { scrollY: window.scrollY };
              break;
            case "scroll-to":
              result = doScrollTo(message.ref, message.position);
              break;

            // --- Wait ---
            case "wait-for-element":
              result = await waitForElement(message.selector, message.timeout);
              break;
            case "wait-for-text":
              result = await waitForText(message.text, message.timeout);
              break;
            case "wait":
              await new Promise((r) => setTimeout(r, message.ms || 1000));
              result = { waited: message.ms || 1000 };
              break;

            // --- Script execution ---
            case "executeScript":
              result = executeScript(message.script!);
              break;
            case "evaluateExpression":
              result = evaluateExpression(message.expression!);
              break;

            // --- Storage ---
            case "getStorage":
              result = getStorage();
              break;

            // --- Legacy compat (old action names) ---
            case "getSnapshot":
              result = getFullSnapshot();
              break;
            case "getHTML":
              result = getHTML(message.selector);
              break;
            case "getText":
              result = getText();
              break;
            case "getMarkdown":
              result = getMarkdown();
              break;

            default:
              throw new Error(`Unknown action: ${message.action}`);
          }
          sendResponse({ success: true, data: result });
        } catch (error) {
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      })();
      return true; // Keep message channel open for async response
    },
  );

  // ==========================================================================
  // Interactive snapshot (ref-based, compact output)
  // ==========================================================================

  async function getInteractiveSnapshot(scope?: string, sources?: boolean): Promise<string> {
    resetRefs();

    const root = scope ? document.querySelector(scope) : document.documentElement;
    if (!root) throw new Error(`Scope element not found: ${scope}`);

    const lines: string[] = [`Page: ${document.title}`, `URL: ${location.href}`, ""];

    // Walk DOM for natively interactive elements
    const elements = collectInteractiveElements(root);

    // Also find cursor-interactive elements (cursor:pointer, onclick, tabindex)
    const cursorElements = collectCursorInteractiveElements(root);

    // Assign refs to all elements first (before any async calls)
    const allEntries: Array<{ ref: string; el: Element; line: string }> = [];

    for (const el of elements) {
      const ref = nextRef();
      refMap.set(ref, el);
      allEntries.push({ ref, el, line: formatRefLine(ref, el) });
    }

    for (const { el, hints, text } of cursorElements) {
      const ref = nextRef();
      refMap.set(ref, el);
      allEntries.push({
        ref,
        el,
        line: `${ref} [clickable] "${text}" (${hints.join(", ")})`,
      });
    }

    // If sources requested, batch-annotate with bridge calls
    if (sources) {
      const annotations = await Promise.all(allEntries.map(({ el }) => getSourceAnnotation(el)));
      for (let i = 0; i < allEntries.length; i++) {
        lines.push(allEntries[i].line + annotations[i]);
      }
    } else {
      for (const entry of allEntries) {
        lines.push(entry.line);
      }
    }

    return lines.join("\n");
  }

  async function getSourceAnnotation(element: Element): Promise<string> {
    try {
      const ancestry = await callBridgeForElement("get-react-ancestry", element);
      if (!ancestry || ancestry.length === 0) return "";

      const nearest = ancestry[0];
      let annotation = ` <- ${nearest.name}`;
      if (nearest.file) {
        annotation += ` (${nearest.file}${nearest.line ? `:${nearest.line}` : ""})`;
      }
      const chain = ancestry
        .slice(1, 3)
        .map((c: any) => c.name)
        .join(" → ");
      if (chain) annotation += ` → ${chain}`;
      return annotation;
    } catch {
      return "";
    }
  }

  function collectInteractiveElements(root: Element): Element[] {
    const elements: Element[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node: Element | null = walker.currentNode as Element;

    while (node) {
      if (isInteractiveElement(node) && isVisible(node)) {
        elements.push(node);
      }
      node = walker.nextNode() as Element | null;
    }
    return elements;
  }

  function isInteractiveElement(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;

    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;

    return false;
  }

  function isVisible(el: Element): boolean {
    if (!(el instanceof HTMLElement)) return true;
    // Quick checks before expensive getComputedStyle
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  function collectCursorInteractiveElements(
    root: Element,
  ): Array<{ el: Element; hints: string[]; text: string }> {
    const results: Array<{ el: Element; hints: string[]; text: string }> = [];
    const allElements = root.querySelectorAll("*");

    for (const el of allElements) {
      // Skip if already captured as interactive
      if (Array.from(refMap.values()).includes(el)) continue;

      const tag = el.tagName.toLowerCase();
      if (INTERACTIVE_TAGS.has(tag)) continue;

      const role = el.getAttribute("role");
      if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) continue;

      if (!isVisible(el)) continue;

      const style = getComputedStyle(el);
      const hasCursorPointer = style.cursor === "pointer";
      const hasOnClick = el.hasAttribute("onclick") || (el as HTMLElement).onclick !== null;
      const tabIndex = el.getAttribute("tabindex");
      const hasTabIndex = tabIndex !== null && tabIndex !== "-1";

      if (!hasCursorPointer && !hasOnClick && !hasTabIndex) continue;

      const text = (el.textContent || "").trim().slice(0, 100);
      if (!text) continue;

      // Skip if a parent is already in refMap (avoid duplicating nested text)
      let parentCaptured = false;
      let parent = el.parentElement;
      while (parent && parent !== root) {
        if (Array.from(refMap.values()).includes(parent)) {
          parentCaptured = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (parentCaptured) continue;

      const hints: string[] = [];
      if (hasCursorPointer) hints.push("cursor:pointer");
      if (hasOnClick) hints.push("onclick");
      if (hasTabIndex) hints.push("tabindex");

      results.push({ el, hints, text });
    }
    return results;
  }

  function formatRefLine(ref: string, el: Element): string {
    const tag = el.tagName.toLowerCase();
    let desc = `${ref} [${tag}`;

    // Add type for inputs
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (type && type !== "text") desc += ` type="${type}"`;
    }

    desc += "]";

    // Add visible text or name
    const name = getAccessibleName(el);
    if (name) {
      desc += ` "${name}"`;
    }

    // Add placeholder
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) {
      desc += ` placeholder="${placeholder}"`;
    }

    // Add href for links (abbreviated)
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href && href !== "#") {
        const short = href.length > 60 ? href.substring(0, 57) + "..." : href;
        desc += ` href="${short}"`;
      }
    }

    // Add checked state for checkboxes/radios
    if (tag === "input") {
      const input = el as HTMLInputElement;
      if (input.type === "checkbox" || input.type === "radio") {
        if (input.checked) desc += " checked";
      }
    }

    return desc;
  }

  function getAccessibleName(el: Element): string {
    // 1. Explicit ARIA labels always win
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent?.trim()?.substring(0, 100) || "";
    }

    // 2. Title attribute (common on icon buttons)
    const title = el.getAttribute("title");
    if (title) return title;

    // 3. Input-specific: labels, placeholder, value
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const input = el as HTMLInputElement;
      if (input.labels?.[0]) return input.labels[0].textContent?.trim()?.substring(0, 100) || "";
      if (input.placeholder) return "";
      if (input.value) return input.value.substring(0, 100);
    }

    // 4. Images: alt text
    if (tag === "img") {
      return el.getAttribute("alt") || "";
    }

    // 5. Direct text nodes first (avoids pulling in deeply nested unrelated text)
    const directText = getDirectText(el);
    if (directText) return directText;

    // 6. For buttons/links/interactive elements: fall back to deep textContent
    //    This catches icon buttons with <span>Label</span> or <svg><title>Icon</title></svg>
    if (
      tag === "button" ||
      tag === "a" ||
      tag === "summary" ||
      el.getAttribute("role") === "button"
    ) {
      // Check children for aria-label (e.g., <svg aria-label="Close">)
      const childWithLabel = el.querySelector("[aria-label]");
      if (childWithLabel) {
        const childLabel = childWithLabel.getAttribute("aria-label");
        if (childLabel) return childLabel;
      }

      // Check for SVG <title> element
      const svgTitle = el.querySelector("svg title");
      if (svgTitle?.textContent) return svgTitle.textContent.trim().substring(0, 100);

      // Deep textContent as last resort
      const deepText = (el.textContent || "").trim().substring(0, 100);
      if (deepText) return deepText;
    }

    return "";
  }

  function getDirectText(el: Element): string {
    let text = "";
    for (let i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === Node.TEXT_NODE) {
        text += el.childNodes[i].textContent || "";
      }
    }
    return text.trim().substring(0, 100);
  }

  // ==========================================================================
  // Full snapshot (old JSON a11y tree — preserved for --full flag)
  // ==========================================================================

  function getFullSnapshot(): DOMNode {
    let uidCounter = 0;
    const uidMap = new Map<string, Element>();

    function buildNode(element: Element): DOMNode {
      const uid = `uid-${uidCounter++}`;
      uidMap.set(uid, element);

      const node: DOMNode = {
        uid,
        role: getRole(element),
        tagName: element.tagName.toLowerCase(),
        name: getAccessibleName(element),
      };

      if (element.classList.length > 0) {
        node.classList = Array.from(element.classList);
      }

      const attrs: Record<string, string> = {};
      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        if (IMPORTANT_ATTRS.has(attr.name)) {
          attrs[attr.name] = attr.value;
        }
      }
      if (Object.keys(attrs).length > 0) {
        node.attributes = attrs;
      }

      const children: DOMNode[] = [];
      for (let i = 0; i < element.children.length; i++) {
        children.push(buildNode(element.children[i]));
      }
      if (children.length > 0) {
        node.children = children;
      }

      return node;
    }

    return buildNode(document.documentElement);
  }

  function getRole(element: Element): string {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;

    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      const type = (element as HTMLInputElement).type.toLowerCase();
      const map: Record<string, string> = {
        button: "button",
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        search: "searchbox",
      };
      return map[type] || "textbox";
    }
    return ROLE_MAP[tag] || "generic";
  }

  // ==========================================================================
  // Content extraction
  // ==========================================================================

  function getHTML(selector?: string): string {
    if (!selector) return document.documentElement.outerHTML;
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    return el.outerHTML;
  }

  function getText(): string {
    return document.body.innerText;
  }

  function getElementText(ref: string): string {
    const el = resolveRef(ref);
    if (!el) throw new Error(`Ref not found: ${ref}`);
    return (el as HTMLElement).innerText || el.textContent || "";
  }

  function getMarkdown(): string {
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    td.use(gfm);
    td.remove(["script", "style", "noscript"]);
    return td.turndown(document.body);
  }

  function getElementMarkdown(ref: string): string {
    const el = resolveRef(ref);
    if (!el) throw new Error(`Ref not found: ${ref}`);
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    td.use(gfm);
    td.remove(["script", "style", "noscript"]);
    return td.turndown(el);
  }

  // ==========================================================================
  // Interaction — ref-based with selector fallback
  // ==========================================================================

  function resolveElement(ref?: string, selector?: string): Element {
    if (ref) {
      const el = resolveRef(ref);
      if (!el) throw new Error(`Ref not found: ${ref}. Re-snapshot to get fresh refs.`);
      return el;
    }
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      return el;
    }
    throw new Error("Either ref or selector must be provided");
  }

  /**
   * Walk up to find the nearest interactive ancestor for click targets.
   * Fixes the beehiiv issue where clicking a <span> inside an <a> doesn't navigate.
   */
  function findClickTarget(el: Element): HTMLElement {
    let current: Element | null = el;
    while (current) {
      if (current instanceof HTMLElement) {
        const tag = current.tagName.toLowerCase();
        if (tag === "a" || tag === "button" || tag === "summary") return current;
        if (current.getAttribute("role") === "button") return current;
        if (current.hasAttribute("onclick") || current.onclick !== null) return current;
      }
      // Don't walk past the element we were given if it's already interactive
      if (current === el && current instanceof HTMLElement) {
        const tag = current.tagName.toLowerCase();
        if (INTERACTIVE_TAGS.has(tag)) return current;
      }
      current = current.parentElement;
    }
    // Fallback: click the original element
    if (!(el instanceof HTMLElement)) throw new Error("Element is not clickable");
    return el as HTMLElement;
  }

  function doClick(ref?: string, selector?: string): { clicked: string } {
    const el = resolveElement(ref, selector);
    const target = findClickTarget(el);
    target.click();
    return { clicked: target.tagName.toLowerCase() };
  }

  function doFill(ref?: string, selector?: string, value?: string): { filled: boolean } {
    const el = resolveElement(ref, selector);
    if (value === undefined) throw new Error("value is required for fill");

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true };
    }
    if (el instanceof HTMLSelectElement) {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true };
    }
    // Try contenteditable
    if (el instanceof HTMLElement && el.isContentEditable) {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { filled: true };
    }
    throw new Error("Element is not fillable (not an input, textarea, select, or contenteditable)");
  }

  function doCheck(ref?: string, selector?: string, checked?: boolean): { checked: boolean } {
    const el = resolveElement(ref, selector);
    if (!(el instanceof HTMLInputElement) || (el.type !== "checkbox" && el.type !== "radio")) {
      throw new Error("Element is not a checkbox or radio");
    }
    el.checked = checked ?? true;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { checked: el.checked };
  }

  function doSelect(ref?: string, selector?: string, value?: string): { selected: string } {
    const el = resolveElement(ref, selector);
    if (!(el instanceof HTMLSelectElement)) throw new Error("Element is not a select dropdown");
    if (value === undefined) throw new Error("value is required for select");
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: el.value };
  }

  // ==========================================================================
  // Semantic find — locate element by attribute + perform action
  // ==========================================================================

  function performAction(el: Element, action: string, value?: string): unknown {
    switch (action) {
      case "click": {
        const target = findClickTarget(el);
        target.click();
        return { clicked: true };
      }
      case "fill":
        return doFill(undefined, undefined, value);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  function performActionOnElement(el: Element, action: string, value?: string): unknown {
    switch (action) {
      case "click": {
        const target = findClickTarget(el);
        target.click();
        return { clicked: true, element: target.tagName.toLowerCase() };
      }
      case "fill": {
        if (value === undefined) throw new Error("value is required for fill action");
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.focus();
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { filled: true };
        }
        if (el instanceof HTMLSelectElement) {
          el.value = value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { filled: true };
        }
        throw new Error("Element is not fillable");
      }
      default:
        throw new Error(`Unknown action: ${action}. Supported: click, fill`);
    }
  }

  function findByText(text: string, action: string, value?: string): unknown {
    // Walk all elements looking for matching visible text
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node: Element | null = walker.currentNode as Element;
    while (node) {
      const nodeText = getDirectText(node);
      if (nodeText && nodeText.toLowerCase().includes(text.toLowerCase())) {
        if (isVisible(node)) return performActionOnElement(node, action, value);
      }
      node = walker.nextNode() as Element | null;
    }
    throw new Error(`No visible element found with text: "${text}"`);
  }

  function findByLabel(label: string, action: string, value?: string): unknown {
    // Check aria-label
    const byAriaLabel = document.querySelector(`[aria-label="${CSS.escape(label)}"]`);
    if (byAriaLabel && isVisible(byAriaLabel))
      return performActionOnElement(byAriaLabel, action, value);

    // Check <label> elements
    const labels = document.querySelectorAll("label");
    for (const labelEl of labels) {
      if (labelEl.textContent?.trim().toLowerCase().includes(label.toLowerCase())) {
        const forId = labelEl.getAttribute("for");
        if (forId) {
          const target = document.getElementById(forId);
          if (target && isVisible(target)) return performActionOnElement(target, action, value);
        }
        // Label might wrap the input
        const input = labelEl.querySelector("input, textarea, select");
        if (input && isVisible(input)) return performActionOnElement(input, action, value);
      }
    }
    throw new Error(`No element found with label: "${label}"`);
  }

  function findByRole(role: string, name?: string, action?: string, value?: string): unknown {
    if (!action) throw new Error("action is required");
    const elements = document.querySelectorAll(`[role="${role}"]`);

    // Also check implicit roles
    const tagMatches: Element[] = [];
    for (const [tag, tagRole] of Object.entries(ROLE_MAP)) {
      if (tagRole === role) {
        tagMatches.push(...document.querySelectorAll(tag));
      }
    }

    const candidates = [...elements, ...tagMatches];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if (name) {
        const elName = getAccessibleName(el);
        if (!elName.toLowerCase().includes(name.toLowerCase())) continue;
      }
      return performActionOnElement(el, action, value);
    }
    throw new Error(`No element found with role="${role}"${name ? ` name="${name}"` : ""}`);
  }

  function findByPlaceholder(placeholder: string, action: string, value?: string): unknown {
    const el =
      document.querySelector(`[placeholder="${CSS.escape(placeholder)}"]`) ||
      document.querySelector(`[placeholder*="${CSS.escape(placeholder)}"]`);
    if (!el) throw new Error(`No element found with placeholder: "${placeholder}"`);
    if (!isVisible(el)) throw new Error(`Element with placeholder "${placeholder}" is not visible`);
    return performActionOnElement(el, action, value);
  }

  // ==========================================================================
  // Scrolling
  // ==========================================================================

  function doScrollTo(ref?: string, position?: string): { scrollY: number } {
    if (ref) {
      const el = resolveRef(ref);
      if (!el) throw new Error(`Ref not found: ${ref}`);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return { scrollY: window.scrollY };
    }
    if (position === "top") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (position === "bottom") {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }
    return { scrollY: window.scrollY };
  }

  // ==========================================================================
  // Wait
  // ==========================================================================

  function waitForElement(selector: string, timeout = 5000): Promise<{ found: boolean }> {
    return new Promise((resolve) => {
      if (document.querySelector(selector)) {
        resolve({ found: true });
        return;
      }
      const observer = new MutationObserver(() => {
        if (document.querySelector(selector)) {
          observer.disconnect();
          resolve({ found: true });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve({ found: !!document.querySelector(selector) });
      }, timeout);
    });
  }

  function waitForText(text: string, timeout = 5000): Promise<{ found: boolean }> {
    return new Promise((resolve) => {
      if (document.body.innerText.includes(text)) {
        resolve({ found: true });
        return;
      }
      const observer = new MutationObserver(() => {
        if (document.body.innerText.includes(text)) {
          observer.disconnect();
          resolve({ found: true });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      setTimeout(() => {
        observer.disconnect();
        resolve({ found: document.body.innerText.includes(text) });
      }, timeout);
    });
  }

  // ==========================================================================
  // Script execution (JailJS for CSP bypass)
  // ==========================================================================

  function executeScript(script: string): unknown {
    try {
      return interpreter.evaluate(parse(script));
    } catch (jailError) {
      try {
        return new Function(script)();
      } catch {
        throw new Error(
          `Script execution failed: ${jailError instanceof Error ? jailError.message : "Unknown error"}`,
        );
      }
    }
  }

  function evaluateExpression(expression: string): unknown {
    try {
      return interpreter.evaluate(parse(expression));
    } catch (jailError) {
      try {
        return eval(expression);
      } catch {
        throw new Error(
          `Expression evaluation failed: ${jailError instanceof Error ? jailError.message : "Unknown error"}`,
        );
      }
    }
  }

  // ==========================================================================
  // Storage
  // ==========================================================================

  function getStorage() {
    const ls: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key) ls[key] = window.localStorage.getItem(key) || "";
    }
    const ss: Record<string, string> = {};
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key) ss[key] = window.sessionStorage.getItem(key) || "";
    }
    return { localStorage: ls, sessionStorage: ss };
  }

  // ==========================================================================
  // Console interception
  // ==========================================================================

  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  function stringify(arg: unknown): string {
    if (typeof arg === "string") return arg;
    if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
    if (arg === null) return "null";
    if (arg === undefined) return "undefined";
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }

  const sendConsole = (type: ConsoleLogEntry["type"], args: unknown[]) => {
    const entry: ConsoleLogEntry = {
      id: crypto.randomUUID(),
      type,
      message: args.map((a) => stringify(a)).join(" "),
      args,
      timestamp: Date.now(),
      url: window.location.href,
    };
    chrome.runtime.sendMessage({ type: "consoleLog", data: entry });
  };

  for (const [level, original] of Object.entries(originals) as [
    ConsoleLogEntry["type"],
    Function,
  ][]) {
    (console as unknown as Record<string, Function>)[level] = (...args: unknown[]) => {
      sendConsole(level, args);
      original.apply(console, args);
    };
  }
}
