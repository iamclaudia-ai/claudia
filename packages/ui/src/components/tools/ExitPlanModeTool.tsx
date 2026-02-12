import { useState, useCallback } from "react";
import type { ToolProps } from "./types";
import { ToolHeader } from "./utils";
import { getToolBadgeConfig } from "./toolConfig";

interface AllowedPrompt {
  tool: string;
  prompt: string;
}

export default function ExitPlanModeTool({
  name,
  parsedInput,
  result,
  isLoading: _isLoading,
  onSendMessage,
}: ToolProps) {
  const config = getToolBadgeConfig(name);
  const allowedPrompts = (parsedInput?.allowedPrompts as AllowedPrompt[]) || [];
  const [submitted, setSubmitted] = useState(false);

  const isAnswered = !!result;
  const isDisabled = submitted || isAnswered;
  const isEntering = name === "EnterPlanMode";

  // Different labels for enter vs exit
  const label = isEntering ? "Entering Plan Mode" : "Plan Ready";
  const description = isEntering
    ? "Plan mode activated. I'll explore the codebase and design an approach before implementation."
    : "A plan has been prepared and is ready for your review. Check the plan above, then approve or request changes.";

  const handleApprove = useCallback(() => {
    if (!onSendMessage) return;
    onSendMessage("Yes, proceed with the plan.");
    setSubmitted(true);
  }, [onSendMessage]);

  const handleRequestChanges = useCallback(() => {
    if (!onSendMessage) return;
    const feedback = prompt("What changes would you like to the plan?");
    if (feedback) {
      onSendMessage(feedback);
      setSubmitted(true);
    }
  }, [onSendMessage]);

  return (
    <div className={`w-full rounded-lg border ${config.colors.border} ${config.colors.bg} overflow-hidden`}>
      {/* Header */}
      <div className={`flex items-center gap-2 px-3 py-2 border-b ${config.colors.border}`}>
        <ToolHeader toolName={name} label={label} />
        {isAnswered && (
          <span className="ml-auto text-[10px] font-medium text-neutral-400 uppercase tracking-wider">
            reviewed
          </span>
        )}
        {submitted && !isAnswered && (
          <span className="ml-auto text-[10px] font-medium text-emerald-500 uppercase tracking-wider">
            sent
          </span>
        )}
      </div>

      <div className="p-3 space-y-3">
        {/* Description */}
        <p className="text-sm text-neutral-600 leading-relaxed">
          {description}
        </p>

        {/* Allowed prompts / permissions - only for ExitPlanMode */}
        {!isEntering && allowedPrompts.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Permissions requested
            </span>
            <div className="space-y-1">
              {allowedPrompts.map((ap, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-1.5"
                >
                  <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-mono font-medium bg-neutral-100 text-neutral-600">
                    {ap.tool}
                  </span>
                  <span className="text-sm text-neutral-700">{ap.prompt}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Action buttons - only for ExitPlanMode */}
        {!isEntering && !isDisabled && onSendMessage && (
          <div className="flex gap-2">
            <button
              onClick={handleApprove}
              className="flex-1 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
            >
              Approve Plan
            </button>
            <button
              onClick={handleRequestChanges}
              className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:border-neutral-400"
            >
              Request Changes
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
