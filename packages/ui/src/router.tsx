/**
 * Claudia Client-Side Router
 *
 * Lightweight pushState router — zero dependencies, ~75 lines.
 * Supports :param patterns, back/forward, and Link components.
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import type { ComponentType, ReactNode } from "react";

// ── Types ────────────────────────────────────────────────────

export interface Route {
  path: string;
  // biome-ignore lint: Page components have varying prop signatures from route params
  component: ComponentType<any>;
  label?: string;
  icon?: string;
}

interface RouterState {
  pathname: string;
  params: Record<string, string>;
  navigate: (path: string) => void;
}

// ── Path Matching ────────────────────────────────────────────

/** Match "/workspace/:workspaceId" against "/workspace/ws_abc" → { workspaceId: "ws_abc" } */
export function matchPath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const paramNames: string[] = [];
  const regexStr = pattern.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  const match = new RegExp(`^${regexStr}$`).exec(pathname);
  if (!match) return null;
  const params: Record<string, string> = {};
  paramNames.forEach((name, i) => {
    params[name] = decodeURIComponent(match[i + 1]);
  });
  return params;
}

// ── Navigation ───────────────────────────────────────────────

/** Navigate without full page reload */
export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// ── Context ──────────────────────────────────────────────────

const RouterContext = createContext<RouterState>({
  pathname: "/",
  params: {},
  navigate,
});

export function useRouter(): RouterState {
  return useContext(RouterContext);
}

// ── Router Component ─────────────────────────────────────────

export function Router({
  routes,
  fallback,
}: {
  routes: Route[];
  fallback?: ReactNode;
}) {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const nav = useCallback((path: string) => navigate(path), []);

  // First match wins
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params !== null) {
      return (
        <RouterContext.Provider value={{ pathname, params, navigate: nav }}>
          <route.component {...params} />
        </RouterContext.Provider>
      );
    }
  }

  return (
    <RouterContext.Provider value={{ pathname, params: {}, navigate: nav }}>
      {fallback ?? null}
    </RouterContext.Provider>
  );
}

// ── Link Component ───────────────────────────────────────────

export function Link({
  to,
  children,
  onClick,
  ...rest
}: { to: string; children: ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(to);
    onClick?.(e);
  };
  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
