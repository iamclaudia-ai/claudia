import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { FilePath, ResultBlock, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function ReadTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const filePath = parsedInput?.file_path as string | undefined;
  const offset = parsedInput?.offset as number | undefined;
  const limit = parsedInput?.limit as number | undefined;

  const collapsedContent = <ToolHeader toolName={name} label={label} />;

  const expandedContent = (
    <div className="space-y-1.5">
      {filePath && <FilePath path={filePath} />}
      {(offset !== undefined || limit !== undefined) && (
        <div className="flex gap-1.5">
          {offset !== undefined && (
            <span className="rounded border border-neutral-200/50 bg-neutral-50/50 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
              offset {offset}
            </span>
          )}
          {limit !== undefined && (
            <span className="rounded border border-neutral-200/50 bg-neutral-50/50 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
              limit {limit}
            </span>
          )}
        </div>
      )}
      {result?.content && <ResultBlock content={result.content} isError={result.is_error} />}
    </div>
  );

  const hasExpanded = filePath || result?.content || offset !== undefined || limit !== undefined;

  return (
    <CollapsibleTool
      collapsedContent={collapsedContent}
      expandedContent={hasExpanded ? expandedContent : null}
      isLoading={isLoading}
      toolName={name}
    />
  );
}
