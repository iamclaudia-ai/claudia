// Main component
export { ClaudiaChat } from "./components/ClaudiaChat";

// Bridge
export { BridgeContext, useBridge } from "./bridge";
export type { PlatformBridge } from "./bridge";

// Types
export type {
  Message,
  ContentBlock,
  TextBlock,
  ImageBlock,
  FileBlock,
  ToolUseBlock,
  Usage,
  Attachment,
  GatewayMessage,
  EditorContext,
} from "./types";

// Hooks
export { useGateway } from "./hooks/useGateway";
export type { UseGatewayOptions, UseGatewayReturn, WorkspaceInfo, SessionInfo } from "./hooks/useGateway";

// Page components (for web client routing)
export { WorkspaceList } from "./components/WorkspaceList";
export { SessionList } from "./components/SessionList";

// Components (for direct use if needed)
export { Header } from "./components/Header";
export { ContextBar } from "./components/ContextBar";
export { MessageList } from "./components/MessageList";
export { MessageContent } from "./components/MessageContent";
export { ToolCallBlock } from "./components/ToolCallBlock";
export { InputArea } from "./components/InputArea";
export { CopyButton } from "./components/CopyButton";
export { ClaudiaThinking } from "./components/ClaudiaThinking";
