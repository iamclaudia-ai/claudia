import { CheckCircle2, ChevronRight, Circle } from "lucide-react";
import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

interface TodoItem {
  content?: string;
  status?: string;
}

export default function TodoWriteTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const todos = (parsedInput?.todos as TodoItem[] | undefined) || [];
  const completedCount = todos.filter((t) => t.status === "completed").length;

  const collapsedContent = (
    <div className="flex items-center gap-1.5">
      <ToolHeader toolName={name} label={label} />
      {todos.length > 0 && (
        <span className="text-[10px] text-neutral-500">
          {completedCount}/{todos.length} completed
        </span>
      )}
    </div>
  );

  const expandedContent =
    todos.length > 0 ? (
      <div className="rounded border border-neutral-200/40 bg-neutral-50/30 px-2 py-1.5">
        <div className="space-y-1">
          {todos.map((todo, index) => (
            <div key={index} className="flex items-start gap-1.5 text-sm">
              <span className="mt-0.5 flex-shrink-0">
                {todo.status === "completed" ? (
                  <CheckCircle2 className="size-3 text-green-600" />
                ) : todo.status === "in_progress" ? (
                  <ChevronRight className="size-3 text-blue-600" />
                ) : (
                  <Circle className="size-3 text-neutral-400" />
                )}
              </span>
              <span
                className={
                  todo.status === "completed"
                    ? "text-neutral-500 line-through"
                    : "text-neutral-700"
                }
              >
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      </div>
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
