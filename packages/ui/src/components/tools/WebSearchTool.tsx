import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { ResultBlock, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function WebSearchTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const query = parsedInput?.query as string | undefined;

  const collapsedContent = <ToolHeader toolName={name} label={label} />;

  const expandedContent = (
    <div className="space-y-1.5">
      {query && <span className="font-mono text-sm text-neutral-600">{query}</span>}
      {result?.content && <ResultBlock content={result.content} isError={result.is_error} />}
    </div>
  );

  const hasExpanded = query || result?.content;

  return (
    <CollapsibleTool
      collapsedContent={collapsedContent}
      expandedContent={hasExpanded ? expandedContent : null}
      isLoading={isLoading}
      toolName={name}
    />
  );
}
