import { createContext, useContext, type ReactNode } from "react";

interface WorkspaceContextValue {
  /** Current workspace CWD for stripping from file paths */
  cwd?: string;
}

const WorkspaceContext = createContext<WorkspaceContextValue>({});

export function WorkspaceProvider({ children, cwd }: { children: ReactNode; cwd?: string }) {
  return <WorkspaceContext.Provider value={{ cwd }}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  return useContext(WorkspaceContext);
}
