import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { InlineCode, ResultBlock, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function GlobTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const pattern = parsedInput?.pattern as string | undefined;
  const path = parsedInput?.path as string | undefined;

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader toolName={name} label={label} />
      {pattern && <InlineCode>{pattern}</InlineCode>}
      {path && (
        <span className="text-[10px] text-neutral-500">in {path}</span>
      )}
    </div>
  );

  const expandedContent = result?.content
    ? <ResultBlock content={result.content} isError={result.is_error} />
    : null;

  return (
    <CollapsibleTool
      collapsedContent={collapsedContent}
      expandedContent={expandedContent}
      isLoading={isLoading}
      toolName={name}
    />
  );
}
