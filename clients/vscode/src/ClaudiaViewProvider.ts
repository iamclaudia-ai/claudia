import * as vscode from 'vscode';
import { EditorContext } from './context';

/**
 * Provides the Claudia chat webview in the sidebar
 */
export class ClaudiaViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudia.chat';

  private _view?: vscode.WebviewView;
  private _currentContext?: EditorContext;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    // Configure webview
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    // Set the HTML content
    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message) => {
      this._handleMessage(message);
    });

    // Send initial context if we have it
    if (this._currentContext) {
      this._postMessage({
        type: 'context',
        context: this._currentContext,
      });
    }
  }

  /**
   * Send a message to the chat
   */
  public sendToChat(text: string, context?: EditorContext) {
    if (!this._view) {
      // Open the view first
      vscode.commands.executeCommand('claudia.chat.focus');
    }

    this._postMessage({
      type: 'sendMessage',
      text,
      context,
    });
  }

  /**
   * Update the current editor context
   */
  public updateContext(context: EditorContext) {
    this._currentContext = context;
    this._postMessage({
      type: 'context',
      context,
    });
  }

  private _postMessage(message: unknown) {
    this._view?.webview.postMessage(message);
  }

  private _handleMessage(message: { type: string; [key: string]: unknown }) {
    switch (message.type) {
      case 'ready':
        // Webview is ready, send current context
        if (this._currentContext) {
          this._postMessage({
            type: 'context',
            context: this._currentContext,
          });
        }
        break;

      case 'openFile':
        // Open a file in the editor
        if (typeof message.path === 'string') {
          vscode.workspace.openTextDocument(message.path).then((doc) => {
            vscode.window.showTextDocument(doc);
          });
        }
        break;

      case 'applyEdit':
        // Apply an edit to a file
        if (typeof message.path === 'string' && typeof message.content === 'string') {
          this._applyEdit({ path: message.path, content: message.content });
        }
        break;

      case 'showInfo':
        if (typeof message.text === 'string') {
          vscode.window.showInformationMessage(message.text);
        }
        break;

      case 'showError':
        if (typeof message.text === 'string') {
          vscode.window.showErrorMessage(message.text);
        }
        break;
    }
  }

  private async _applyEdit(message: { path: string; content: string }) {
    try {
      const doc = await vscode.workspace.openTextDocument(message.path);
      await vscode.window.showTextDocument(doc);

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
      );

      edit.replace(doc.uri, fullRange, message.content);
      await vscode.workspace.applyEdit(edit);

      vscode.window.showInformationMessage(`Applied edit to ${message.path}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to apply edit: ${error}`);
    }
  }

  private _getHtmlContent(_webview: vscode.Webview): string {
    const config = vscode.workspace.getConfiguration('claudia');
    const gatewayUrl = config.get<string>('gatewayUrl', 'ws://localhost:3033/ws');
    const includeFileContext = config.get<boolean>('includeFileContext', true);

    // For now, we'll create a simple embedded chat UI
    // Later we can load the full web UI via iframe or rebuild it here
    return /* html */ `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${gatewayUrl.replace('ws:', 'ws:').replace('wss:', 'wss:')} ws://localhost:* wss://localhost:*; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
        <title>Claudia</title>
        <style>
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }

          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
          }

          .header {
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
          }

          .header h1 {
            font-size: 14px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .status {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
          }

          .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--vscode-errorForeground);
          }

          .status-dot.connected {
            background: var(--vscode-testing-iconPassed);
          }

          .context-bar {
            padding: 8px 12px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .messages {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
          }

          .message {
            margin-bottom: 16px;
            padding: 8px 12px;
            border-radius: 8px;
            max-width: 95%;
          }

          .message.user {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            margin-left: auto;
          }

          .message.assistant {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
          }

          .message pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
          }

          .message code {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
          }

          .input-area {
            padding: 12px;
            border-top: 1px solid var(--vscode-panel-border);
          }

          .input-wrapper {
            display: flex;
            gap: 8px;
          }

          textarea {
            flex: 1;
            resize: none;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
          }

          textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
          }

          button {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
          }

          button:hover {
            background: var(--vscode-button-hoverBackground);
          }

          button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .thinking {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            padding: 8px;
          }

          .thinking::after {
            content: '';
            animation: dots 1.5s infinite;
          }

          @keyframes dots {
            0%, 20% { content: '.'; }
            40% { content: '..'; }
            60%, 100% { content: '...'; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>💙 Claudia</h1>
          <div class="status">
            <span class="status-dot" id="statusDot"></span>
            <span id="statusText">Connecting...</span>
          </div>
        </div>

        <div class="context-bar" id="contextBar">
          No file open
        </div>

        <div class="messages" id="messages"></div>

        <div class="input-area">
          <div class="input-wrapper">
            <textarea
              id="input"
              rows="3"
              placeholder="Ask Claudia... (Cmd+Enter to send)"
            ></textarea>
            <button id="sendBtn" disabled>Send</button>
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          const gatewayUrl = '${gatewayUrl}';
          const includeFileContext = ${includeFileContext};

          let ws = null;
          let currentContext = null;
          let isQuerying = false;
          let sessionId = null;

          const statusDot = document.getElementById('statusDot');
          const statusText = document.getElementById('statusText');
          const contextBar = document.getElementById('contextBar');
          const messagesEl = document.getElementById('messages');
          const input = document.getElementById('input');
          const sendBtn = document.getElementById('sendBtn');

          // Connect to gateway
          function connect() {
            ws = new WebSocket(gatewayUrl);

            ws.onopen = () => {
              statusDot.classList.add('connected');
              statusText.textContent = 'Connected';
              sendBtn.disabled = false;

              // Subscribe to events
              sendRequest('subscribe', { events: ['session.*'] });
              sendRequest('session.info');
            };

            ws.onclose = () => {
              statusDot.classList.remove('connected');
              statusText.textContent = 'Disconnected';
              sendBtn.disabled = true;

              // Reconnect after delay
              setTimeout(connect, 3000);
            };

            ws.onmessage = (event) => {
              const msg = JSON.parse(event.data);
              handleMessage(msg);
            };
          }

          function sendRequest(method, params) {
            if (!ws) return;
            ws.send(JSON.stringify({
              type: 'req',
              id: Math.random().toString(36).slice(2, 8),
              method,
              params
            }));
          }

          function handleMessage(msg) {
            if (msg.type === 'res' && msg.payload?.sessionId) {
              sessionId = msg.payload.sessionId;
              statusText.textContent = 'Session: ' + sessionId.slice(0, 8);
            }

            if (msg.type === 'event') {
              const event = msg.event?.replace('session.', '');
              handleStreamEvent(event, msg.payload);
            }
          }

          let currentAssistantMsg = null;

          function handleStreamEvent(event, payload) {
            switch (event) {
              case 'message_start':
                isQuerying = true;
                currentAssistantMsg = addMessage('assistant', '');
                break;

              case 'message_stop':
                isQuerying = false;
                currentAssistantMsg = null;
                break;

              case 'content_block_delta':
                if (payload.delta?.text && currentAssistantMsg) {
                  currentAssistantMsg.textContent += payload.delta.text;
                  messagesEl.scrollTop = messagesEl.scrollHeight;
                }
                break;
            }
          }

          function addMessage(role, text) {
            const div = document.createElement('div');
            div.className = 'message ' + role;
            div.textContent = text;
            messagesEl.appendChild(div);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return div;
          }

          function sendPrompt() {
            const text = input.value.trim();
            if (!text || !ws) return;

            // Build prompt with context if enabled
            let prompt = text;
            if (includeFileContext && currentContext) {
              const ctx = currentContext;
              let contextStr = '\\n\\n[Context: ' + (ctx.relativePath || ctx.filePath) + ' (' + ctx.languageId + ')';
              if (ctx.selection) {
                contextStr += ', selection: lines ' + ctx.selectionRange.startLine + '-' + ctx.selectionRange.endLine;
              }
              contextStr += ']';
              // Only add context if it's not already in the message
              if (!text.includes('[Context:')) {
                prompt = text + contextStr;
              }
            }

            input.value = '';
            addMessage('user', text);
            sendRequest('session.prompt', { content: prompt });
          }

          // Handle keyboard shortcuts
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault();
              sendPrompt();
            }
          });

          sendBtn.addEventListener('click', sendPrompt);

          // Handle messages from VS Code extension
          window.addEventListener('message', (event) => {
            const msg = event.data;

            switch (msg.type) {
              case 'context':
                currentContext = msg.context;
                if (msg.context) {
                  contextBar.textContent = (msg.context.relativePath || msg.context.fileName) +
                    ' | ' + msg.context.languageId +
                    ' | Line ' + msg.context.currentLine;
                } else {
                  contextBar.textContent = 'No file open';
                }
                break;

              case 'sendMessage':
                input.value = msg.text;
                if (msg.context) {
                  currentContext = msg.context;
                }
                sendPrompt();
                break;
            }
          });

          // Notify extension we're ready
          vscode.postMessage({ type: 'ready' });

          // Connect on load
          connect();
        </script>
      </body>
      </html>
    `;
  }
}
