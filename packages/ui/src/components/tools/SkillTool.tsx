import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { ResultBlock, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function SkillTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);

  const collapsedContent = (
    <ToolHeader toolName={name} label={label} />
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
