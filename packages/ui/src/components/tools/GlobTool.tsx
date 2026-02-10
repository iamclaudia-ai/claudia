import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { InlineCode, ResultBlock, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function GlobTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const pattern = parsedInput?.pattern as string | undefined;
  const path = parsedInput?.path as string | undefined;

  const collapsedContent = <ToolHeader toolName={name} label={label} />;

  const expandedContent = (
    <div className="space-y-1.5">
      {pattern && <InlineCode>{pattern}</InlineCode>}
      {path && <span className="text-[10px] text-neutral-500">in {path}</span>}
      {result?.content && <ResultBlock content={result.content} isError={result.is_error} />}
    </div>
  );

  const hasExpanded = pattern || path || result?.content;

  return (
    <CollapsibleTool
      collapsedContent={collapsedContent}
      expandedContent={hasExpanded ? expandedContent : null}
      isLoading={isLoading}
      toolName={name}
    />
  );
}
