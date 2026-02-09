import { memo } from "react";
import { CollapsibleTool } from "./tools/CollapsibleTool";
import { ToolHeader } from "./tools/utils";
import BashTool from "./tools/BashTool";
import ReadTool from "./tools/ReadTool";
import WriteTool from "./tools/WriteTool";
import EditTool from "./tools/EditTool";
import GlobTool from "./tools/GlobTool";
import GrepTool from "./tools/GrepTool";
import WebFetchTool from "./tools/WebFetchTool";
import WebSearchTool from "./tools/WebSearchTool";
import TaskTool from "./tools/TaskTool";
import TodoWriteTool from "./tools/TodoWriteTool";
import SkillTool from "./tools/SkillTool";
import NotebookEditTool from "./tools/NotebookEditTool";
import KillShellTool from "./tools/KillShellTool";

interface ToolCallBlockProps {
  name: string;
  input: string;
  result?: {
    content: string;
    is_error?: boolean;
  };
  isLoading?: boolean;
}

/** Parse the JSON input string, returning null on failure */
function parseInput(input: string): Record<string, unknown> | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export const ToolCallBlock = memo(function ToolCallBlock({
  name,
  input,
  result,
  isLoading,
}: ToolCallBlockProps) {
  const parsedInput = parseInput(input);
  const isError = result?.is_error;

  const toolProps = { name, parsedInput, result, isLoading, isError };

  switch (name) {
    case "Bash":
    case "BashOutput":
      return <BashTool {...toolProps} />;
    case "Read":
      return <ReadTool {...toolProps} />;
    case "Write":
      return <WriteTool {...toolProps} />;
    case "Edit":
      return <EditTool {...toolProps} />;
    case "Glob":
      return <GlobTool {...toolProps} />;
    case "Grep":
      return <GrepTool {...toolProps} />;
    case "WebFetch":
      return <WebFetchTool {...toolProps} />;
    case "WebSearch":
      return <WebSearchTool {...toolProps} />;
    case "Task":
      return <TaskTool {...toolProps} />;
    case "TodoWrite":
      return <TodoWriteTool {...toolProps} />;
    case "Skill":
      return <SkillTool {...toolProps} />;
    case "NotebookEdit":
      return <NotebookEditTool {...toolProps} />;
    case "KillShell":
      return <KillShellTool {...toolProps} />;

    default: {
      // Fallback for unknown tools — show raw JSON
      const collapsedContent = (
        <ToolHeader toolName={name} label={name} />
      );

      const expandedContent = input ? (
        <pre className="overflow-x-hidden rounded bg-neutral-50 px-2 py-1.5 font-mono text-sm whitespace-pre-wrap break-words text-neutral-700">
          {JSON.stringify(parsedInput, null, 2) || input}
        </pre>
      ) : null;

      return (
        <CollapsibleTool
          collapsedContent={collapsedContent}
          expandedContent={expandedContent}
          isLoading={isLoading}
          toolName={name}
        />
      );
    }
  }
});
