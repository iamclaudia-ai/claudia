/**
 * React ErrorBoundary — Catches render errors within the React tree.
 *
 * Delegates error reporting and heartbeat management to window.__claudiaBeacon,
 * which is installed in index.html BEFORE React loads. This ensures errors are
 * caught even if React fails to initialize entirely.
 *
 * The beacon in index.html handles:
 *   - Global error/unhandledrejection listeners (catches module load failures)
 *   - Health heartbeat (starts only after React renders into #root)
 *   - Error reporting via POST /api/client-error
 *
 * This ErrorBoundary handles:
 *   - React componentDidCatch errors (with componentStack info)
 *   - Stopping the heartbeat when React crashes
 *   - Showing a fallback error UI
 */

import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";

// Global beacon API exposed by index.html inline script
declare global {
  interface Window {
    __claudiaBeacon?: {
      stopHeartbeat: () => void;
      restartHeartbeat: () => void;
      reportError: (type: string, message: string, stack?: string) => void;
    };
  }
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Report via the global beacon (installed in index.html)
    const stack = [error.stack || "", info.componentStack || ""]
      .filter(Boolean)
      .join("\n\n--- Component Stack ---\n");
    window.__claudiaBeacon?.reportError("react", error.message, stack);

    // Stop heartbeat — app is in error state
    window.__claudiaBeacon?.stopHeartbeat();
  }

  reset = (): void => {
    this.setState({ error: null });
    window.__claudiaBeacon?.restartHeartbeat();
  };

  render(): ReactNode {
    if (this.state.error) {
      const { fallback } = this.props;

      if (typeof fallback === "function") {
        return fallback(this.state.error, this.reset);
      }

      if (fallback) {
        return fallback;
      }

      // Default error UI
      return (
        <div
          style={{
            padding: "32px",
            maxWidth: "600px",
            margin: "64px auto",
            fontFamily: "-apple-system, system-ui, sans-serif",
            color: "#e4e4e7",
          }}
        >
          <div
            style={{
              background: "#27272a",
              borderRadius: "12px",
              border: "1px solid #3f3f46",
              padding: "24px",
            }}
          >
            <h2
              style={{
                fontSize: "18px",
                fontWeight: 600,
                marginBottom: "12px",
                color: "#f87171",
              }}
            >
              💔 Something went wrong
            </h2>
            <p style={{ fontSize: "14px", color: "#a1a1aa", marginBottom: "16px" }}>
              Claudia hit an unexpected error. The error has been reported automatically.
            </p>
            <pre
              style={{
                background: "#09090b",
                borderRadius: "8px",
                padding: "12px",
                fontSize: "12px",
                overflow: "auto",
                maxHeight: "200px",
                color: "#f87171",
                marginBottom: "16px",
              }}
            >
              {this.state.error.message}
              {this.state.error.stack && `\n\n${this.state.error.stack}`}
            </pre>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={this.reset}
                style={{
                  background: "#3f3f46",
                  color: "#e4e4e7",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "13px",
                }}
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{
                  background: "transparent",
                  color: "#71717a",
                  border: "1px solid #3f3f46",
                  padding: "8px 16px",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "13px",
                }}
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
