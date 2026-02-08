import { useBridge } from "../bridge";

interface HeaderProps {
  isConnected: boolean;
  sessionId: string | null;
}

export function Header({ isConnected, sessionId }: HeaderProps) {
  const bridge = useBridge();

  return (
    <header className="p-4 border-b border-gray-200">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">💙 Claudia</h1>
        <div className="flex items-center gap-2 text-sm">
          {bridge.openTerminal && (
            <button
              onClick={() => bridge.openTerminal!()}
              className="px-2 py-1 rounded text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 transition-colors"
              title="Split terminal below"
            >
              ⌨ Terminal
            </button>
          )}
          <span
            className={`w-2 h-2 rounded-full ${
              isConnected ? "bg-green-500" : "bg-red-500"
            }`}
          />
          <span className="text-gray-500">
            {isConnected
              ? `Session: ${sessionId?.slice(0, 8) || "..."}`
              : "Disconnected"}
          </span>
        </div>
      </div>
    </header>
  );
}
