import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { ResultBlock, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function TaskTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const subagentType = parsedInput?.subagent_type as string | undefined;
  const model = parsedInput?.model as string | undefined;
  const prompt = parsedInput?.prompt as string | undefined;

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader toolName={name} label={label} />
      {subagentType && (
        <span className="rounded border border-purple-200/50 bg-purple-50/50 px-1.5 py-0.5 text-[10px] font-medium text-purple-600">
          {subagentType}
        </span>
      )}
      {model && (
        <span className="rounded border border-blue-200/50 bg-blue-50/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
          {model}
        </span>
      )}
    </div>
  );

  const expandedContent = (
    <div className="space-y-1.5">
      {prompt && (
        <pre className="overflow-x-auto rounded bg-neutral-100/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-neutral-600">
          {prompt}
        </pre>
      )}
      {result?.content && (
        <ResultBlock content={result.content} isError={result.is_error} />
      )}
    </div>
  );

  return (
    <CollapsibleTool
      collapsedContent={collapsedContent}
      expandedContent={prompt || result?.content ? expandedContent : null}
      isLoading={isLoading}
      toolName={name}
    />
  );
}
