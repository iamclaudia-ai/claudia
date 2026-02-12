import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { FilePath, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function WriteTool({ name, parsedInput, result: _result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const filePath = parsedInput?.file_path as string | undefined;
  const content = parsedInput?.content as string | undefined;

  const collapsedContent = <ToolHeader toolName={name} label={label} />;

  const expandedContent = (
    <div className="space-y-1.5">
      {filePath && <FilePath path={filePath} />}
      {content && (
        <pre className="overflow-x-hidden rounded bg-neutral-100/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-neutral-600">
          {content}
        </pre>
      )}
    </div>
  );

  const hasExpanded = filePath || content;

  return (
    <CollapsibleTool
      collapsedContent={collapsedContent}
      expandedContent={hasExpanded ? expandedContent : null}
      isLoading={isLoading}
      toolName={name}
    />
  );
}
