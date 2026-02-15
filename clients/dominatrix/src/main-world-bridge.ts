/**
 * DOMINATRIX Main World Bridge
 *
 * Runs in the page's MAIN world (not the isolated content script world).
 * This gives access to page-level JS properties like __reactFiber$, __vue__, etc.
 *
 * Communication: CustomEvent-based RPC with the content script.
 * - Content script dispatches "dmx-bridge-req" with { id, method, selector, ... }
 * - Bridge dispatches "dmx-bridge-res" with { id, result, error }
 *
 * Element targeting: Content script stamps data-dmx-target on elements,
 * bridge queries by that attribute selector.
 *
 * Source map symbolication: When _debugSource is unavailable (production builds),
 * generates stack traces from component functions and resolves via source maps.
 * Priority: _debugSource → source map symbolication → null
 */

(function () {
  if ((window as any).__dominatrix_bridge__) return;
  (window as any).__dominatrix_bridge__ = true;

  // ==========================================================================
  // Types
  // ==========================================================================

  interface ComponentSource {
    name: string;
    file: string | null;
    line: number | null;
  }

  interface SourceMapMapping {
    file: string;
    line: number;
    column: number;
  }

  // ==========================================================================
  // Caches
  // ==========================================================================

  const sourceMapCache = new Map<string, any>();
  const componentSourceCache = new WeakMap<
    Function,
    { file: string | null; line: number | null }
  >();

  // ==========================================================================
  // Bridge RPC listener
  // ==========================================================================

  function sendResponse(id: string, result: any, error: string | null) {
    document.dispatchEvent(
      new CustomEvent("dmx-bridge-res", {
        detail: { id, result, error },
      }),
    );
  }

  document.addEventListener("dmx-bridge-req", ((e: CustomEvent) => {
    const { id, method, selector } = e.detail;

    try {
      const el = selector ? document.querySelector(selector) : null;

      switch (method) {
        case "get-react-ancestry": {
          // Async — uses source map resolution when _debugSource is unavailable
          getReactAncestryWithSources(el)
            .then((result) => sendResponse(id, result, null))
            .catch((err) =>
              sendResponse(id, null, err instanceof Error ? err.message : String(err)),
            );
          return; // Don't send synchronous response
        }

        case "get-page-global": {
          const path = e.detail.path as string;
          let result = path.split(".").reduce((o: any, k: string) => o?.[k], window);
          result = JSON.parse(JSON.stringify(result ?? null));
          sendResponse(id, result, null);
          return;
        }

        case "get-element-keys": {
          const result = el
            ? Object.keys(el).filter((k) => k.startsWith("__") || k.startsWith("$"))
            : null;
          sendResponse(id, result, null);
          return;
        }

        default:
          sendResponse(id, null, `Unknown bridge method: ${method}`);
          return;
      }
    } catch (err) {
      sendResponse(id, null, err instanceof Error ? err.message : String(err));
    }
  }) as EventListener);

  // ==========================================================================
  // React fiber walking with source map fallback
  // ==========================================================================

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

    // Collect component nodes from fiber tree
    const components: Array<{ name: string; type: any; debugSource: any }> = [];
    let current = fiber;

    while (current) {
      // tag 0 = FunctionComponent, 1 = ClassComponent, 11 = ForwardRef, 15 = SimpleMemoComponent
      if (current.tag === 0 || current.tag === 1 || current.tag === 11 || current.tag === 15) {
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

    // Resolve source for each component
    const ancestry: ComponentSource[] = [];

    for (const comp of components) {
      let file: string | null = null;
      let line: number | null = null;

      // Priority 1: _debugSource (dev builds)
      if (comp.debugSource?.fileName) {
        file = normalizeSourcePath(comp.debugSource.fileName);
        line = comp.debugSource.lineNumber || null;
      }

      // Priority 2: Component-level cache
      if (!file && typeof comp.type === "function" && componentSourceCache.has(comp.type)) {
        const cached = componentSourceCache.get(comp.type)!;
        file = cached.file;
        line = cached.line;
      }

      // Priority 3: Stack trace + source map symbolication
      if (!file && typeof comp.type === "function") {
        try {
          const loc = getComponentBundledLocation(comp.type);
          if (loc) {
            // Fast path: Vite dev server serves individual modules where the URL
            // IS the source path (e.g., http://localhost:3001/src/components/Button.tsx)
            // Check if the URL looks like a direct source file (has a recognizable extension)
            const urlPath = new URL(loc.url).pathname;
            const isDirectSource = /\.(tsx?|jsx?|vue|svelte)(\?.*)?$/.test(urlPath);

            if (isDirectSource) {
              // URL is the source — extract path directly
              file = normalizeSourcePath(urlPath);
              line = loc.line;
            } else {
              // Bundled file — need source map resolution
              const sourceMap = await getSourceMap(loc.url);
              if (sourceMap) {
                const resolved = resolveFromSourceMap(sourceMap, loc.line, loc.col);
                if (resolved) {
                  file = resolved.file;
                  line = resolved.line;
                }
              }
            }
          }
        } catch {
          // Source map resolution failed — continue with null
        }

        // Cache result (even if null) to avoid re-resolving
        componentSourceCache.set(comp.type, { file, line });
      }

      ancestry.push({ name: comp.name, file, line });
    }

    return ancestry.length > 0 ? ancestry : null;
  }

  // ==========================================================================
  // Stack trace → bundled location
  // ==========================================================================

  function getComponentBundledLocation(
    componentFn: Function,
  ): { url: string; line: number; col: number } | null {
    // Strategy: We need to get a stack frame pointing to the component function's
    // definition site. Multiple approaches in priority order:
    //
    // Method 1: Call the function and capture stack from the thrown error
    //   - Most components throw when called outside React (hooks fail)
    //   - The component's own frame is in the stack trace
    //
    // Method 2: V8 structured stack trace API with Error.captureStackTrace
    //   - Create a fake error and capture the stack relative to the function
    //
    // Method 3: Wrap the function call and parse the Error.stack string
    //   - Parse Chrome/Firefox stack trace formats

    // Method 1: V8 prepareStackTrace — get structured call sites
    try {
      const origPrepare = (Error as any).prepareStackTrace;
      let foundUrl: string | null = null;
      let foundLine: number | null = null;
      let foundCol: number | null = null;

      (Error as any).prepareStackTrace = (_err: any, callSites: any[]) => {
        // Look through frames for one matching our component function
        for (const site of callSites) {
          try {
            const fn = site.getFunction?.();
            if (fn === componentFn) {
              foundUrl = site.getFileName?.() || null;
              foundLine = site.getLineNumber?.() || null;
              foundCol = site.getColumnNumber?.() || null;
              break;
            }
          } catch {
            // getFunction may throw in strict mode (ES modules)
          }
        }
        // Fallback: find the first frame that's in APP code, not node_modules/react
        // When a component calls useState() and it throws, the stack looks like:
        //   react-dom_client.js:4177  ← the throw site (useState)
        //   MyComponent.tsx:15        ← the component calling useState ← WE WANT THIS
        //   react-dom_client.js:...   ← React's render calling the component
        // So we skip node_modules frames to find the first app source frame.
        if (!foundUrl) {
          for (const site of callSites) {
            const fileName = site.getFileName?.();
            if (
              fileName &&
              fileName.startsWith("http") &&
              !fileName.includes("/node_modules/") &&
              !fileName.includes("/.vite/deps/")
            ) {
              foundUrl = fileName;
              foundLine = site.getLineNumber?.() || null;
              foundCol = site.getColumnNumber?.() || null;
              break;
            }
          }
        }
        return "";
      };

      // Try calling — most components throw when hooks are used outside React
      try {
        componentFn({});
      } catch (e: any) {
        // Access .stack to trigger prepareStackTrace
        void e?.stack;
      }

      // If the function didn't throw, we didn't get a stack.
      // Try creating an error inside a wrapper to capture from call site.
      if (!foundUrl) {
        try {
          // Create wrapper that throws immediately
          const wrapper = function () {
            componentFn({});
            throw new Error("__dmx_probe__");
          };
          try {
            wrapper();
          } catch (e: any) {
            void e?.stack;
          }
        } catch {
          // ignore
        }
      }

      (Error as any).prepareStackTrace = origPrepare;

      if (foundUrl && foundLine) {
        return { url: foundUrl, line: foundLine, col: foundCol || 0 };
      }
    } catch {
      // V8 API not available — fall through
    }

    // Method 2: Parse Error.stack string from thrown error
    try {
      let stack = "";
      try {
        componentFn({});
      } catch (e: any) {
        if (e?.stack) stack = e.stack;
      }

      // If the function didn't throw, force an error via wrapper
      if (!stack) {
        try {
          const wrapper = function __dmx_wrapper__() {
            componentFn({});
            throw new Error("__dmx_probe__");
          };
          try {
            wrapper();
          } catch (e: any) {
            stack = e?.stack || "";
          }
        } catch {
          // ignore
        }
      }

      if (stack) {
        // Parse ALL frames to find the component's frame
        // Chrome: "    at FnName (https://example.com/file.js:123:45)"
        // Chrome anonymous: "    at https://example.com/file.js:123:45"
        const frameRegex = /at\s+(?:(\S+)\s+)?\(?(.+?):(\d+):(\d+)\)?/g;
        let match;
        while ((match = frameRegex.exec(stack)) !== null) {
          const fnName = match[1] || "";
          const url = match[2];
          const line = parseInt(match[3]);
          const col = parseInt(match[4]);

          // Skip: node_modules, .vite/deps, chrome-extension, bridge itself
          if (url.includes("/node_modules/")) continue;
          if (url.includes("/.vite/deps/")) continue;
          if (url.startsWith("chrome-extension://")) continue;
          if (url.includes("main-world-bridge")) continue;

          // First http frame that isn't library code is our component
          if (url.startsWith("http")) {
            return { url, line, col };
          }
        }
      }
    } catch {
      // Fall through
    }

    return null;
  }

  // ==========================================================================
  // Source map fetching + caching
  // ==========================================================================

  async function getSourceMap(bundleUrl: string): Promise<any | null> {
    if (sourceMapCache.has(bundleUrl)) return sourceMapCache.get(bundleUrl);

    try {
      const bundleRes = await fetch(bundleUrl);
      const bundleText = await bundleRes.text();

      // Look for //# sourceMappingURL=... (or //@ for older format)
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

  // ==========================================================================
  // VLQ decoder + source map position resolution
  // ==========================================================================

  const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function decodeVLQ(encoded: string): number[] {
    const values: number[] = [];
    let shift = 0;
    let value = 0;

    for (const char of encoded) {
      const digit = VLQ_CHARS.indexOf(char);
      if (digit === -1) continue;

      const cont = digit & 32;
      const raw = digit & 31;
      value += raw << shift;

      if (cont) {
        shift += 5;
      } else {
        const isNeg = value & 1;
        value = value >> 1;
        values.push(isNeg ? -value : value);
        value = 0;
        shift = 0;
      }
    }

    return values;
  }

  function resolveFromSourceMap(
    sourceMap: any,
    targetLine: number,
    targetCol: number,
  ): SourceMapMapping | null {
    try {
      const mappingLines = sourceMap.mappings.split(";");
      if (targetLine - 1 >= mappingLines.length) return null;

      // Cumulative state across all lines (source file index, source line, source col are relative)
      let srcFileIdx = 0;
      let srcLine = 0;
      let srcCol = 0;
      let lastMatch: SourceMapMapping | null = null;

      for (let lineIdx = 0; lineIdx < targetLine; lineIdx++) {
        const lineMapping = mappingLines[lineIdx];
        if (!lineMapping) continue;

        const segments = lineMapping.split(",");
        let genCol = 0; // Generated column resets per line

        for (const seg of segments) {
          if (!seg) continue;
          const decoded = decodeVLQ(seg);
          if (decoded.length < 4) {
            // Segments with < 4 fields have no source mapping
            genCol += decoded[0] || 0;
            continue;
          }

          genCol += decoded[0];
          srcFileIdx += decoded[1];
          srcLine += decoded[2];
          srcCol += decoded[3];

          // On the target line, track the closest segment at or before targetCol
          if (lineIdx === targetLine - 1) {
            const sourceFile = sourceMap.sources?.[srcFileIdx];
            if (sourceFile && genCol <= targetCol - 1) {
              lastMatch = {
                file: normalizeSourcePath(sourceFile, sourceMap.sourceRoot),
                line: srcLine + 1,
                column: srcCol + 1,
              };
            }
            // If we've passed the target column, the last match is our best
            if (genCol >= targetCol - 1 && lastMatch) {
              return lastMatch;
            }
          }
        }
      }

      // Return last match on target line (or last segment if col wasn't exact)
      return lastMatch;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Path normalization
  // ==========================================================================

  function normalizeSourcePath(filePath: string, sourceRoot?: string): string {
    let normalized = filePath;

    const prefixes = [
      /^webpack:\/\/\/?\.\//,
      /^webpack:\/\/[^/]*\//,
      /^turbopack:\/\/\[project\]\//,
      /^turbopack:\/\/\/?\.\//,
      /^\.\//,
      /^\/?\.\//,
      /^rsc:\/\/React\//,
      /^file:\/\//,
    ];

    for (const prefix of prefixes) {
      normalized = normalized.replace(prefix, "");
    }

    if (sourceRoot && !normalized.startsWith("/")) {
      normalized = sourceRoot.replace(/\/$/, "") + "/" + normalized;
    }

    return normalized;
  }
})();
