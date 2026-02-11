import { useState, useCallback, useRef, useEffect } from "react";
import { FileText, FileImage, File, X } from "lucide-react";
import type { Attachment, Usage } from "../types";
import { useBridge } from "../bridge";

function getFileIcon(mediaType: string) {
  if (mediaType.startsWith("image/")) return FileImage;
  if (mediaType.startsWith("text/") || mediaType === "application/pdf")
    return FileText;
  return File;
}

interface InputAreaProps {
  input: string;
  onInputChange(value: string): void;
  attachments: Attachment[];
  onAttachmentsChange(attachments: Attachment[]): void;
  isConnected: boolean;
  isQuerying: boolean;
  usage: Usage | null;
  onSend(): void;
  onInterrupt(): void;
}

export function InputArea({
  input,
  onInputChange,
  attachments,
  onAttachmentsChange,
  isConnected,
  isQuerying,
  usage,
  onSend,
  onInterrupt,
}: InputAreaProps) {
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bridge = useBridge();

  // Auto-resize textarea to fit content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const processFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const [header, data] = dataUrl.split(",");
        const mediaType =
          header.match(/data:(.*?);/)?.[1] || "application/octet-stream";
        const isImage = mediaType.startsWith("image/");
        onAttachmentsChange([
          ...attachments,
          {
            type: isImage ? "image" : "file",
            mediaType,
            data,
            filename: file.name,
          },
        ]);
      };
      reader.readAsDataURL(file);
    },
    [attachments, onAttachmentsChange],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      for (const item of items) {
        if (
          item.type.startsWith("image/") ||
          item.type.startsWith("text/") ||
          item.type === "application/pdf"
        ) {
          const file = item.getAsFile();
          if (!file) continue;
          e.preventDefault();
          processFile(file);
        }
      }
    },
    [processFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        processFile(file);
      }
    },
    [processFile],
  );

  const removeAttachment = useCallback(
    (index: number) => {
      onAttachmentsChange(attachments.filter((_, i) => i !== index));
    },
    [attachments, onAttachmentsChange],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      onInputChange(value);
      bridge.saveDraft(value);
    },
    [onInputChange, bridge],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        onSend();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onInterrupt();
        return;
      }
    },
    [onSend, onInterrupt],
  );

  return (
    <footer className="p-4 border-t border-gray-200">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((attachment, idx) => {
            const FileIcon = getFileIcon(attachment.mediaType);
            return (
              <div key={idx} className="relative group">
                {attachment.type === "image" ? (
                  <img
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                    alt={attachment.filename || `Attachment ${idx + 1}`}
                    className="h-16 w-16 object-cover rounded-md border border-gray-300"
                  />
                ) : (
                  <div className="h-16 px-3 flex items-center gap-2 rounded-md border border-gray-300 bg-gray-50">
                    <FileIcon className="w-5 h-5 text-gray-500" />
                    <span className="text-xs text-gray-700 max-w-24 truncate">
                      {attachment.filename || "file"}
                    </span>
                  </div>
                )}
                <button
                  onClick={() => removeAttachment(idx)}
                  className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div
        className={`relative ${isDragging ? "ring-2 ring-blue-500 ring-offset-2" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Type a message... (⌘↵ send, ESC stop)"
          disabled={!isConnected}
          className="w-full p-3 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 placeholder:text-gray-300"
          rows={1}
          style={{ maxHeight: "200px", overflow: "auto" }}
        />
        {isDragging && (
          <div className="absolute inset-0 bg-blue-50/80 rounded-lg flex items-center justify-center pointer-events-none">
            <span className="text-blue-600 font-medium">Drop files here</span>
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between">
        {usage
          ? (() => {
              const total =
                usage.input_tokens +
                usage.cache_read_input_tokens +
                usage.cache_creation_input_tokens;
              const max = 200000;
              const percent = Math.round((total / max) * 100);
              const colorClass =
                percent >= 80
                  ? "text-red-600"
                  : percent >= 60
                    ? "text-orange-500"
                    : "text-gray-600";
              return (
                <div className={`text-xs font-mono ${colorClass}`}>
                  Context: {total.toLocaleString()}/{max.toLocaleString()} {percent}%
                </div>
              );
            })()
          : <div />}
        <div className="flex gap-2">
          <button
            onClick={onInterrupt}
            disabled={!isQuerying}
            className="px-3 py-1.5 rounded-md text-sm text-white bg-red-500 hover:bg-red-600 disabled:opacity-0 transition-opacity"
          >
            Stop
          </button>
          <button
            onClick={onSend}
            disabled={
              !isConnected || (!input.trim() && attachments.length === 0)
            }
            className="px-4 py-1.5 rounded-md text-sm text-white bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300"
          >
            Send
          </button>
        </div>
      </div>
    </footer>
  );
}
