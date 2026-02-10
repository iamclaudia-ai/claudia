import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { FilePath, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function EditTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const filePath = parsedInput?.file_path as string | undefined;
  const oldString = parsedInput?.old_string as string | undefined;
  const newString = parsedInput?.new_string as string | undefined;
  const replaceAll = parsedInput?.replace_all as boolean | undefined;

  const collapsedContent = <ToolHeader toolName={name} label={label} />;

  const expandedContent = (
    <div className="space-y-1.5">
      {filePath && <FilePath path={filePath} />}
      {replaceAll && (
        <span className="rounded border border-orange-200/50 bg-orange-50/50 px-1.5 py-0.5 text-[10px] font-medium text-orange-600">
          replace all
        </span>
      )}
      <pre className="overflow-x-hidden rounded bg-red-100/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-red-700">
        {oldString || ""}
      </pre>
      <pre className="overflow-x-hidden rounded bg-green-100/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-green-700">
        {newString || ""}
      </pre>
    </div>
  );

  return (
    <CollapsibleTool
      collapsedContent={collapsedContent}
      expandedContent={expandedContent}
      isLoading={isLoading}
      toolName={name}
    />
  );
}
