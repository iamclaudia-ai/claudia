/** Shared props passed from the ToolCallBlock router to each tool component */
export interface ToolProps {
  name: string;
  parsedInput: Record<string, unknown> | null;
  result?: { content: string; is_error?: boolean };
  isLoading?: boolean;
  isError?: boolean;
}
