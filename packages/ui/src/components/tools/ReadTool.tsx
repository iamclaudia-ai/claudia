import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { FilePath, ResultBlock, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function ReadTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const filePath = parsedInput?.file_path as string | undefined;
  const offset = parsedInput?.offset as number | undefined;
  const limit = parsedInput?.limit as number | undefined;

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader toolName={name} label={label} />
      {filePath && <FilePath path={filePath} />}
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
