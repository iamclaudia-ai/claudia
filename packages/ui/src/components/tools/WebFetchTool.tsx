import type { ToolProps } from "./types";
import { CollapsibleTool } from "./CollapsibleTool";
import { ResultBlock, ToolHeader } from "./utils";
import { getToolLabel } from "./toolConfig";

export default function WebFetchTool({ name, parsedInput, result, isLoading }: ToolProps) {
  const label = getToolLabel(name, parsedInput);
  const url = parsedInput?.url as string | undefined;
  const prompt = parsedInput?.prompt as string | undefined;

  const collapsedContent = <ToolHeader toolName={name} label={label} />;

  const expandedContent = (
    <div className="space-y-1.5">
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded border border-neutral-200/50 bg-neutral-50/50 px-1.5 py-0.5 font-mono text-[10px] text-blue-600 hover:text-blue-700 hover:underline"
        >
          {url}
        </a>
      )}
      {prompt && (
        <div className="text-[10px] text-neutral-600">{prompt}</div>
      )}
      {result?.content && (
        <ResultBlock content={result.content} isError={result.is_error} />
      )}
    </div>
  );

  const hasExpanded = url || prompt || result?.content;

  return (
    <CollapsibleTool
      collapsedContent={collapsedContent}
      expandedContent={hasExpanded ? expandedContent : null}
      isLoading={isLoading}
      toolName={name}
    />
  );
}
