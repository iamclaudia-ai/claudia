import {
  BookOpen,
  Brain,
  ClipboardList,
  FileEdit,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  MessageCircleQuestion,
  Search,
  SearchCode,
  Sparkles,
  Terminal,
  XCircle,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

export interface ToolBadgeConfig {
  icon: ReactNode;
  colors: {
    border: string;
    bg: string;
    text: string;
    hoverBg: string;
    chevron: string;
    iconColor: string;
  };
}

/** Single source of truth for tool icons and color schemes */
export function getToolBadgeConfig(toolName: string): ToolBadgeConfig {
  switch (toolName) {
    // File operations — Emerald
    case "Read":
      return {
        icon: <FileText className="size-2.5" />,
        colors: emeraldColors,
      };
    case "Write":
      return {
        icon: <FilePen className="size-2.5" />,
        colors: emeraldColors,
      };
    case "Edit":
      return {
        icon: <FileEdit className="size-2.5" />,
        colors: emeraldColors,
      };

    // Shell operations — Amber
    case "Bash":
    case "BashOutput":
      return {
        icon: <Terminal className="size-2.5" />,
        colors: amberColors,
      };
    case "KillShell":
      return {
        icon: <XCircle className="size-2.5" />,
        colors: amberColors,
      };

    // Search operations — Violet
    case "Grep":
      return {
        icon: <SearchCode className="size-2.5" />,
        colors: violetColors,
      };
    case "Glob":
    case "WebSearch":
      return {
        icon: <Search className="size-2.5" />,
        colors: violetColors,
      };

    // Web operations — Cyan
    case "WebFetch":
      return {
        icon: <Globe className="size-2.5" />,
        colors: cyanColors,
      };

    // Task management — Indigo
    case "Task":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskGet":
    case "TaskList":
      return {
        icon: <Zap className="size-2.5" />,
        colors: indigoColors,
      };
    case "TodoWrite":
      return {
        icon: <ListTodo className="size-2.5" />,
        colors: indigoColors,
      };

    // Skills — Rose
    case "Skill":
      return {
        icon: <Sparkles className="size-2.5" />,
        colors: roseColors,
      };

    // Notebook — Teal
    case "NotebookEdit":
      return {
        icon: <BookOpen className="size-2.5" />,
        colors: tealColors,
      };

    // Interactive / user-prompt tools — Pink
    case "AskUserQuestion":
      return {
        icon: <MessageCircleQuestion className="size-2.5" />,
        colors: pinkColors,
      };
    case "ExitPlanMode":
    case "EnterPlanMode":
      return {
        icon: <ClipboardList className="size-2.5" />,
        colors: amberColors,
      };

    // Default fallback — Blue (MCP tools get Rose/Sparkles like Skill)
    default:
      if (toolName.startsWith("mcp__")) {
        return {
          icon: <Sparkles className="size-2.5" />,
          colors: roseColors,
        };
      }
      return {
        icon: null,
        colors: blueColors,
      };
  }
}

/** Generate a smart compact label from tool name + parsed input */
export function getToolLabel(
  name: string,
  parsedInput: Record<string, unknown> | null,
): string {
  if (!parsedInput) return name;

  switch (name) {
    case "Read":
    case "Write":
    case "Edit": {
      const filePath = parsedInput.file_path as string | undefined;
      if (filePath) {
        const fileName = filePath.split("/").pop() || filePath;
        return fileName.length > 20 ? `${fileName.substring(0, 17)}...` : fileName;
      }
      return name;
    }
    case "Bash": {
      const desc = parsedInput.description as string | undefined;
      const cmd = parsedInput.command as string | undefined;
      if (desc) return desc;
      if (cmd) {
        const first = cmd.split(" ")[0];
        return first.length > 15 ? `${first.substring(0, 12)}...` : first;
      }
      return "Run command";
    }
    case "BashOutput":
      return "Bash Output";
    case "Grep": {
      const pattern = parsedInput.pattern as string | undefined;
      if (pattern) {
        const p = pattern.length > 15 ? `${pattern.substring(0, 12)}...` : pattern;
        return `Search "${p}"`;
      }
      return "Search";
    }
    case "Glob": {
      const pattern = parsedInput.pattern as string | undefined;
      if (pattern) {
        const p = pattern.length > 15 ? `${pattern.substring(0, 12)}...` : pattern;
        return `Find ${p}`;
      }
      return "Find";
    }
    case "Task": {
      const desc = parsedInput.description as string | undefined;
      if (desc) {
        return desc.length > 25 ? `${desc.substring(0, 22)}...` : desc;
      }
      return "Task";
    }
    case "TaskCreate":
      return "Create Task";
    case "TaskUpdate":
      return "Update Task";
    case "TaskGet":
      return "Get Task";
    case "TaskList":
      return "List Tasks";
    case "WebFetch": {
      const url = parsedInput.url as string | undefined;
      if (url) {
        try {
          const hostname = new URL(url).hostname;
          return hostname.length > 20 ? `${hostname.substring(0, 17)}...` : hostname;
        } catch {
          return url.length > 20 ? `${url.substring(0, 17)}...` : url;
        }
      }
      return "Fetch";
    }
    case "WebSearch": {
      const query = parsedInput.query as string | undefined;
      if (query) {
        return query.length > 20 ? `${query.substring(0, 17)}...` : query;
      }
      return "Search";
    }
    case "TodoWrite": {
      const todos = parsedInput.todos as Array<{ status?: string }> | undefined;
      if (todos && todos.length > 0) {
        const completed = todos.filter((t) => t.status === "completed").length;
        return `Todo ${completed}/${todos.length}`;
      }
      return "Todo List";
    }
    case "Skill": {
      const skill = parsedInput.skill as string | undefined;
      return skill ? `Skill(${skill})` : "Skill";
    }
    case "KillShell":
      return "Kill Shell";
    case "NotebookEdit": {
      const editMode = (parsedInput.edit_mode as string) || "replace";
      return `${editMode.charAt(0).toUpperCase() + editMode.slice(1)} notebook cell`;
    }
    case "AskUserQuestion": {
      const questions = parsedInput.questions as Array<{ header?: string }> | undefined;
      if (questions?.length === 1 && questions[0].header) {
        return questions[0].header;
      }
      return "Question";
    }
    case "ExitPlanMode":
      return "Plan Ready";
    case "EnterPlanMode":
      return "Enter Plan Mode";

    default:
      // MCP tools: mcp__server__method → readable label
      if (name.startsWith("mcp__")) {
        const parts = name.replace("mcp__", "").split("__");
        const method = parts[parts.length - 1];
        // Convert snake_case to Title Case
        return method.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      }
      return name;
  }
}

// ── Color palettes ──────────────────────────────────────────

const emeraldColors = {
  border: "border-emerald-200/60",
  bg: "bg-emerald-50/80",
  text: "text-emerald-600",
  hoverBg: "hover:bg-emerald-100/80",
  chevron: "text-emerald-400",
  iconColor: "text-emerald-500",
};

const amberColors = {
  border: "border-amber-200/60",
  bg: "bg-amber-50/80",
  text: "text-amber-600",
  hoverBg: "hover:bg-amber-100/80",
  chevron: "text-amber-400",
  iconColor: "text-amber-500",
};

const violetColors = {
  border: "border-violet-200/60",
  bg: "bg-violet-50/80",
  text: "text-violet-600",
  hoverBg: "hover:bg-violet-100/80",
  chevron: "text-violet-400",
  iconColor: "text-violet-500",
};

const cyanColors = {
  border: "border-cyan-200/60",
  bg: "bg-cyan-50/80",
  text: "text-cyan-600",
  hoverBg: "hover:bg-cyan-100/80",
  chevron: "text-cyan-400",
  iconColor: "text-cyan-500",
};

const indigoColors = {
  border: "border-indigo-200/60",
  bg: "bg-indigo-50/80",
  text: "text-indigo-600",
  hoverBg: "hover:bg-indigo-100/80",
  chevron: "text-indigo-400",
  iconColor: "text-indigo-500",
};

const roseColors = {
  border: "border-rose-200/60",
  bg: "bg-rose-50/80",
  text: "text-rose-600",
  hoverBg: "hover:bg-rose-100/80",
  chevron: "text-rose-400",
  iconColor: "text-rose-500",
};

const tealColors = {
  border: "border-teal-200/60",
  bg: "bg-teal-50/80",
  text: "text-teal-600",
  hoverBg: "hover:bg-teal-100/80",
  chevron: "text-teal-400",
  iconColor: "text-teal-500",
};

const pinkColors = {
  border: "border-pink-200/60",
  bg: "bg-pink-50/80",
  text: "text-pink-600",
  hoverBg: "hover:bg-pink-100/80",
  chevron: "text-pink-400",
  iconColor: "text-pink-500",
};

const blueColors = {
  border: "border-blue-200/60",
  bg: "bg-blue-50/80",
  text: "text-blue-600",
  hoverBg: "hover:bg-blue-100/80",
  chevron: "text-blue-400",
  iconColor: "text-blue-500",
};

const purpleColors = {
  border: "border-purple-200/60",
  bg: "bg-purple-50/80",
  text: "text-purple-600",
  hoverBg: "hover:bg-purple-100/80",
  chevron: "text-purple-400",
  iconColor: "text-purple-500",
};

// ── Thinking badge config ──────────────────────────────────

/** Thinking badge configuration — single source of truth */
export function getThinkingBadgeConfig(): ToolBadgeConfig {
  return {
    icon: <Brain className="size-3" />,
    colors: purpleColors,
  };
}

/** Thinking label for collapsed badge */
export function getThinkingLabel(isComplete: boolean, durationMs?: number): string {
  const durationSeconds =
    typeof durationMs === "number" ? Math.max(1, Math.round(durationMs / 1000)) : null;

  if (isComplete && durationSeconds) {
    return `${durationSeconds}s`;
  }
  if (isComplete) {
    return "Thought";
  }
  return "thinking...";
}
