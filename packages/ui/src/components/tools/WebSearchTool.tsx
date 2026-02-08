import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { InlineCode, ResultBlock, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function WebSearchTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const query = parsedInput?.query as string | undefined;

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader toolName={name} label={label} />
      {query && <InlineCode>{query}</InlineCode>}
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
