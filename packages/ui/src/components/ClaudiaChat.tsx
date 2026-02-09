import { useState, useCallback, useEffect } from "react";
import { Transition } from "@headlessui/react";
import { BridgeContext, useBridge } from "../bridge";
import type { PlatformBridge } from "../bridge";
import type { Attachment } from "../types";
import { useGateway } from "../hooks/useGateway";
import type { UseGatewayOptions } from "../hooks/useGateway";
import { WorkspaceProvider } from "../contexts/WorkspaceContext";
import { Header } from "./Header";
import { ContextBar } from "./ContextBar";
import { MessageList } from "./MessageList";
import { InputArea } from "./InputArea";
import { ClaudiaThinking } from "./ClaudiaThinking";

interface ClaudiaChatProps {
  bridge: PlatformBridge;
  /** Gateway options (sessionId for web, autoDiscoverCwd for VS Code) */
  gatewayOptions?: UseGatewayOptions;
}

export function ClaudiaChat({ bridge, gatewayOptions }: ClaudiaChatProps) {
  return (
    <BridgeContext.Provider value={bridge}>
      <ChatInner gatewayOptions={gatewayOptions} />
    </BridgeContext.Provider>
  );
}

function ChatInner({ gatewayOptions }: { gatewayOptions?: UseGatewayOptions }) {
  const bridge = useBridge();
  const gateway = useGateway(bridge.gatewayUrl, gatewayOptions);

  const [input, setInput] = useState(() => bridge.loadDraft());
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Get editor context if bridge provides it
  const editorContext = bridge.useEditorContext?.();

  // Listen for external send requests (e.g. "Explain This Code" from VS Code)
  useEffect(() => {
    if (!bridge.onSendRequest) return;
    return bridge.onSendRequest((text) => {
      setInput(text);
      // Auto-send after a tick so the input renders first
      setTimeout(() => {
        gateway.sendPrompt(text, []);
        setInput("");
        bridge.saveDraft("");
      }, 0);
    });
  }, [bridge, gateway]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    gateway.sendPrompt(input, attachments);
    setInput("");
    setAttachments([]);
    bridge.saveDraft("");
  }, [input, attachments, gateway, bridge]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
  }, []);

  return (
    <WorkspaceProvider cwd={gateway.workspace?.cwd}>
      <div className="flex flex-col h-screen w-full">
        <Header
          isConnected={gateway.isConnected}
          sessionId={gateway.sessionId}
          sessionRecordId={gateway.sessionRecordId}
          workspace={gateway.workspace}
          sessions={gateway.sessions}
          sessionConfig={gateway.sessionConfig}
          onCreateSession={gateway.createNewSession}
          onSwitchSession={gateway.switchSession}
        />

        {bridge.showContextBar && <ContextBar context={editorContext} />}

        <MessageList
          messages={gateway.messages}
          visibleCount={gateway.visibleCount}
          isQuerying={gateway.isQuerying}
          onLoadEarlier={gateway.loadEarlierMessages}
          messagesContainerRef={gateway.messagesContainerRef}
          messagesEndRef={gateway.messagesEndRef}
        />

        {/* Thinking indicator */}
        <Transition
          show={gateway.isQuerying}
          enter="transition-all duration-300 ease-out"
          enterFrom="opacity-0 translate-y-4 scale-95"
          enterTo="opacity-100 translate-y-0 scale-100"
          leave="transition-all duration-200 ease-in"
          leaveFrom="opacity-100 translate-y-0 scale-100"
          leaveTo="opacity-0 translate-y-2 scale-95"
        >
          <div className="fixed bottom-40 right-8 z-50 bg-white/50 backdrop-blur-sm rounded-2xl shadow-2xl drop-shadow-xl p-4 border border-purple-100/50">
            <ClaudiaThinking count={gateway.eventCount} size="lg" />
          </div>
        </Transition>

        <InputArea
          input={input}
          onInputChange={handleInputChange}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          isConnected={gateway.isConnected}
          isQuerying={gateway.isQuerying}
          usage={gateway.usage}
          onSend={handleSend}
          onInterrupt={gateway.sendInterrupt}
        />
      </div>
    </WorkspaceProvider>
  );
}
