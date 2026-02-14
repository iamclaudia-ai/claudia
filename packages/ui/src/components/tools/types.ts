/** Shared props passed from the ToolCallBlock router to each tool component */
export interface ToolProps {
  name: string;
  parsedInput: Record<string, unknown> | null;
  result?: { content: string; is_error?: boolean };
  isLoading?: boolean;
  isError?: boolean;
  /** The tool_use_id from the Claude API (for sending tool_result) */
  toolUseId?: string;
  /** Send a message to the chat (for interactive tools like AskUserQuestion) */
  onSendMessage?: (text: string) => void;
  /** Send a tool_result for interactive tools (ExitPlanMode, etc.) */
  onSendToolResult?: (toolUseId: string, content: string, isError?: boolean) => void;
}
