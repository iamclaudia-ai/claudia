import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { FilePath, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function NotebookEditTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const notebookPath = parsedInput?.notebook_path as string | undefined;
  const cellType = parsedInput?.cell_type as string | undefined;
  const editMode = parsedInput?.edit_mode as string | undefined;
  const newSource = parsedInput?.new_source as string | undefined;

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader toolName={name} label={label} />
      {notebookPath && <FilePath path={notebookPath} />}
      {cellType && (
        <span className="rounded border border-purple-200/50 bg-purple-50/50 px-1.5 py-0.5 text-[10px] font-medium text-purple-600">
          {cellType}
        </span>
      )}
    </div>
  );

  const expandedContent =
    editMode !== "delete" && newSource ? (
      <pre className="overflow-x-hidden rounded bg-neutral-100/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-neutral-600">
        {newSource}
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
