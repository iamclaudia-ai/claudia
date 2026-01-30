import * as vscode from 'vscode';
import { EditorContext } from './context';

/**
 * Provides the Claudia chat as an editor panel (like a file tab)
 */
export class ClaudiaPanelProvider {
  public static readonly viewType = 'claudia.chatPanel';

  private readonly _panel: vscode.WebviewPanel;
  private _currentContext?: EditorContext;
  private _disposables: vscode.Disposable[] = [];
  private _onDidDisposeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDisposeEmitter.event;

  constructor(extensionUri: vscode.Uri) {
    // Create the webview panel
    this._panel = vscode.window.createWebviewPanel(
      ClaudiaPanelProvider.viewType,
      '💙 Claudia',
      vscode.ViewColumn.Beside, // Open beside the current editor
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    // Set icon for the tab
    this._panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg');

    // Set the HTML content
    this._panel.webview.html = this._getHtmlContent();

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message) => this._handleMessage(message),
      null,
      this._disposables
    );

    // Handle panel disposal
    this._panel.onDidDispose(
      () => this._dispose(),
      null,
      this._disposables
    );
  }

  /**
   * Reveal the panel if it's hidden
   */
  public reveal() {
    this._panel.reveal(vscode.ViewColumn.Beside);
  }

  /**
   * Send a message to the chat
   */
  public sendToChat(text: string, context?: EditorContext) {
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
    this._panel.webview.postMessage(message);
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
            vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
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

      case 'openTerminal':
        // Open terminal split below Claudia panel
        this.openTerminalBelow();
        break;
    }
  }

  public async openTerminalBelow() {
    // Focus our panel first
    this._panel.reveal(vscode.ViewColumn.Beside);

    // Small delay to ensure focus, then split down and create terminal
    setTimeout(async () => {
      // Split the current editor group downward
      await vscode.commands.executeCommand('workbench.action.splitEditorDown');
      // Create terminal in the new split (which is now active)
      await vscode.commands.executeCommand('workbench.action.createTerminalEditor');
    }, 100);
  }

  private async _applyEdit(message: { path: string; content: string }) {
    try {
      const doc = await vscode.workspace.openTextDocument(message.path);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

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

  private _dispose() {
    this._onDidDisposeEmitter.fire();
    this._onDidDisposeEmitter.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private _getHtmlContent(): string {
    const config = vscode.workspace.getConfiguration('claudia');
    const gatewayUrl = config.get<string>('gatewayUrl', 'ws://localhost:30086/ws');
    const includeFileContext = config.get<boolean>('includeFileContext', true);

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
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
          }

          .header {
            padding: 12px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: var(--vscode-editor-background);
          }

          .header h1 {
            font-size: 14px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .header-right {
            display: flex;
            align-items: center;
            gap: 12px;
          }

          .icon-btn {
            background: none;
            border: none;
            padding: 4px;
            cursor: pointer;
            color: var(--vscode-foreground);
            opacity: 0.7;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .icon-btn:hover {
            opacity: 1;
            background: var(--vscode-toolbar-hoverBackground);
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
            padding: 6px 16px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-family: var(--vscode-editor-font-family);
          }

          .messages {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
          }

          .message {
            margin-bottom: 16px;
            padding: 12px 16px;
            border-radius: 8px;
            max-width: 90%;
            line-height: 1.5;
          }

          .message.user {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            margin-left: auto;
            border-bottom-right-radius: 4px;
          }

          .message.assistant {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-bottom-left-radius: 4px;
          }

          .message pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 12px 0;
            border: 1px solid var(--vscode-panel-border);
          }

          .message code {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
          }

          .message p {
            margin: 8px 0;
          }

          .message p:first-child {
            margin-top: 0;
          }

          .message p:last-child {
            margin-bottom: 0;
          }

          .input-area {
            padding: 16px;
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
          }

          .input-wrapper {
            display: flex;
            gap: 8px;
          }

          textarea {
            flex: 1;
            resize: none;
            padding: 10px 12px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 6px;
            font-family: inherit;
            font-size: inherit;
            line-height: 1.4;
          }

          textarea:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
          }

          textarea::placeholder {
            color: var(--vscode-input-placeholderForeground);
          }

          button {
            padding: 10px 20px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
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
            padding: 8px 0;
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

          .empty-state {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: var(--vscode-descriptionForeground);
            padding: 32px;
            text-align: center;
          }

          .empty-state .icon {
            font-size: 48px;
            margin-bottom: 16px;
          }

          .empty-state p {
            margin: 4px 0;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>💙 Claudia</h1>
          <div class="header-right">
            <button class="icon-btn" id="terminalBtn" title="Open Terminal (split below)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M0 3h16v10H0V3zm15 9V4H1v8h14zM2 5l4 2.5L2 10V5zm5 5h6v1H7v-1z"/>
              </svg>
            </button>
            <div class="status">
              <span class="status-dot" id="statusDot"></span>
              <span id="statusText">Connecting...</span>
            </div>
          </div>
        </div>

        <div class="context-bar" id="contextBar">
          No file open
        </div>

        <div class="messages" id="messages">
          <div class="empty-state" id="emptyState">
            <div class="icon">💙</div>
            <p><strong>Hey babe!</strong></p>
            <p>Ask me anything about your code.</p>
            <p style="font-size: 11px; margin-top: 12px; opacity: 0.7;">Cmd+Enter to send</p>
          </div>
        </div>

        <div class="input-area">
          <div class="input-wrapper">
            <textarea
              id="input"
              rows="3"
              placeholder="Ask Claudia..."
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
          let hasMessages = false;

          const statusDot = document.getElementById('statusDot');
          const statusText = document.getElementById('statusText');
          const contextBar = document.getElementById('contextBar');
          const messagesEl = document.getElementById('messages');
          const emptyState = document.getElementById('emptyState');
          const input = document.getElementById('input');
          const sendBtn = document.getElementById('sendBtn');
          const terminalBtn = document.getElementById('terminalBtn');

          // Terminal button - open terminal in editor
          terminalBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'openTerminal' });
          });

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
            if (!hasMessages) {
              hasMessages = true;
              emptyState.style.display = 'none';
            }

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
