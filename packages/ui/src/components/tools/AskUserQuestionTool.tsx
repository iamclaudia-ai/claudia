import { useState, useCallback, useMemo } from "react";
import type { ToolProps } from "./types";
import { ToolHeader } from "./utils";
import { getToolBadgeConfig } from "./toolConfig";

interface Question {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/**
 * Parse which options were selected from the CLI tool_result content.
 *
 * Answered format:
 *   'User has answered your questions: "question"="Answer Label", "question"="Answer Label"...'
 *
 * Rejected format (is_error):
 *   'The user doesn't want to proceed...\n(No answer provided)'
 */
function parseHistoricalAnswers(
  resultContent: string,
  questions: Question[],
): Record<number, Set<string>> {
  const answers: Record<number, Set<string>> = {};

  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx];
    for (const opt of q.options) {
      // Match ="label" pattern from the CLI result format
      if (resultContent.includes(`="${opt.label}"`)) {
        if (!answers[qIdx]) answers[qIdx] = new Set();
        answers[qIdx].add(opt.label);
      }
    }
  }

  return answers;
}

export default function AskUserQuestionTool({
  name,
  parsedInput,
  result,
  isLoading: _isLoading,
  onSendMessage,
}: ToolProps) {
  const questions = (parsedInput?.questions as Question[]) || [];
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, Set<string>>>({});
  const [submitted, setSubmitted] = useState(false);
  const config = getToolBadgeConfig(name);

  // Already answered (result came back from CLI, even if error)
  const isAnswered = !!result;
  const wasRejected = result?.is_error === true;

  // Parse historical answers from the result content
  const historicalAnswers = useMemo(() => {
    if (!result?.content || wasRejected) return {};
    return parseHistoricalAnswers(result.content, questions);
  }, [result, wasRejected, questions]);

  // Use historical answers for display when answered, live selection when interactive
  const displayAnswers = isAnswered ? historicalAnswers : selectedAnswers;
  const hasHistoricalAnswers = Object.values(historicalAnswers).some((s) => s.size > 0);

  const toggleOption = useCallback((qIdx: number, label: string, multiSelect: boolean) => {
    setSelectedAnswers((prev) => {
      const current = prev[qIdx] || new Set<string>();
      const next = new Set(current);
      if (multiSelect) {
        if (next.has(label)) next.delete(label);
        else next.add(label);
      } else {
        next.clear();
        next.add(label);
      }
      return { ...prev, [qIdx]: next };
    });
  }, []);

  const handleSubmit = useCallback(() => {
    if (!onSendMessage) return;

    const parts: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const selected = selectedAnswers[i];
      if (selected && selected.size > 0) {
        const answer = Array.from(selected).join(", ");
        if (questions.length === 1) {
          parts.push(`I choose: ${answer}`);
        } else {
          parts.push(`${questions[i].header}: ${answer}`);
        }
      }
    }

    if (parts.length > 0) {
      onSendMessage(parts.join("\n"));
      setSubmitted(true);
    }
  }, [onSendMessage, questions, selectedAnswers]);

  const handleCustomResponse = useCallback(() => {
    if (!onSendMessage) return;
    const text = prompt("Enter your response:");
    if (text) {
      onSendMessage(`I choose: ${text}`);
      setSubmitted(true);
    }
  }, [onSendMessage]);

  if (questions.length === 0) {
    return (
      <div className="flex items-center gap-1.5">
        <ToolHeader toolName={name} label="Ask Question" />
      </div>
    );
  }

  const isDisabled = submitted || isAnswered;

  return (
    <div className={`w-full rounded-lg border ${config.colors.border} ${config.colors.bg} overflow-hidden`}>
      {/* Header */}
      <div className={`flex items-center gap-2 px-3 py-2 border-b ${config.colors.border}`}>
        <ToolHeader toolName={name} label="Question" />
        {isAnswered && (
          <span className={`ml-auto text-[10px] font-medium uppercase tracking-wider ${
            wasRejected ? "text-amber-500" : hasHistoricalAnswers ? "text-emerald-500" : "text-neutral-400"
          }`}>
            {wasRejected ? "skipped" : "answered"}
          </span>
        )}
        {submitted && !isAnswered && (
          <span className="ml-auto text-[10px] font-medium text-emerald-500 uppercase tracking-wider">
            sent
          </span>
        )}
      </div>

      {/* Questions */}
      <div className="p-3 space-y-4">
        {questions.map((q, qIdx) => (
          <div key={qIdx} className="space-y-2">
            {/* Question header chip */}
            {q.header && (
              <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${config.colors.text} ${config.colors.bg} border ${config.colors.border}`}>
                {q.header}
              </span>
            )}

            {/* Question text */}
            <p className="text-sm text-neutral-700 leading-relaxed">
              {q.question}
            </p>

            {/* Options */}
            <div className="space-y-1.5">
              {q.options.map((opt, optIdx) => {
                const isSelected = displayAnswers[qIdx]?.has(opt.label);
                return (
                  <button
                    key={optIdx}
                    disabled={isDisabled}
                    onClick={() => toggleOption(qIdx, opt.label, q.multiSelect)}
                    className={`w-full text-left rounded-md border px-3 py-2 transition-all ${
                      isDisabled
                        ? "opacity-60 cursor-default"
                        : "cursor-pointer hover:shadow-sm"
                    } ${
                      isSelected
                        ? `border-blue-400 bg-blue-50 ring-1 ring-blue-200`
                        : `border-neutral-200 bg-white hover:border-neutral-300`
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {/* Radio/checkbox indicator */}
                      <div className={`mt-0.5 flex-shrink-0 h-4 w-4 rounded-${q.multiSelect ? "sm" : "full"} border-2 flex items-center justify-center ${
                        isSelected
                          ? "border-blue-500 bg-blue-500"
                          : "border-neutral-300 bg-white"
                      }`}>
                        {isSelected && (
                          <svg className="h-2.5 w-2.5 text-white" viewBox="0 0 12 12" fill="currentColor">
                            <path d="M10.28 2.28L3.989 8.575 1.695 6.28A1 1 0 00.28 7.695l3 3a1 1 0 001.414 0l7-7A1 1 0 0010.28 2.28z" />
                          </svg>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-neutral-800">
                          {opt.label}
                        </span>
                        {opt.description && (
                          <p className="text-xs text-neutral-500 mt-0.5 leading-relaxed">
                            {opt.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}

              {/* "Other" option */}
              {!isDisabled && onSendMessage && (
                <button
                  onClick={() => handleCustomResponse()}
                  className="w-full text-left rounded-md border border-dashed border-neutral-300 px-3 py-2 text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-600 transition-colors cursor-pointer"
                >
                  Other...
                </button>
              )}
            </div>
          </div>
        ))}

        {/* Submit button */}
        {!isDisabled && onSendMessage && (
          <button
            onClick={handleSubmit}
            disabled={Object.values(selectedAnswers).every((s) => !s || s.size === 0)}
            className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Submit Answer
          </button>
        )}
      </div>
    </div>
  );
}
