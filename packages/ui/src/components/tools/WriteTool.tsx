import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { FilePath, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function WriteTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const filePath = parsedInput?.file_path as string | undefined;
  const content = parsedInput?.content as string | undefined;

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader toolName={name} label={label} />
      {filePath && <FilePath path={filePath} />}
    </div>
  );

  const expandedContent = content ? (
    <pre className="overflow-x-auto rounded bg-neutral-100/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-neutral-600">
      {content}
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
