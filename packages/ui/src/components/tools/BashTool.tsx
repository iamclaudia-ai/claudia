import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function BashTool({ name, parsedInput, result, isLoading, isError }: ToolProps) {
  const label = getToolLabel(name, parsedInput);

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader toolName={name} label={label} />
    </div>
  );

  const command = parsedInput?.command as string | undefined;
  const resultContent = result?.content;

  const expandedContent = (
    <div className="space-y-1.5">
      {command && (
        <code className="block font-mono text-sm break-words whitespace-pre-wrap text-neutral-700">
          $ {command}
        </code>
      )}
      {resultContent && (
        <pre
          className={`overflow-x-hidden rounded px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap ${
            isError
              ? "bg-red-100/50 text-red-700"
              : "bg-neutral-100/50 text-neutral-600"
          }`}
        >
          {resultContent}
        </pre>
      )}
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
