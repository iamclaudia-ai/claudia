import * as vscode from "vscode";
import { EditorContext } from "./context";
import * as crypto from "crypto";

/**
 * Provides the Claudia chat as an editor panel using the shared @claudia/ui
 * React component, bundled into dist/webview/
 */
export class ClaudiaPanelProvider {
  public static readonly viewType = "claudia.chatPanel";

  private readonly _panel: vscode.WebviewPanel;
  private _currentContext?: EditorContext;
  private _disposables: vscode.Disposable[] = [];
  private _onDidDisposeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDisposeEmitter.event;

  private _onDidChangeViewColumnEmitter = new vscode.EventEmitter<number>();
  public readonly onDidChangeViewColumn = this._onDidChangeViewColumnEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside,
  ) {
    // Create the webview panel
    this._panel = vscode.window.createWebviewPanel(
      ClaudiaPanelProvider.viewType,
      "💙 Claudia",
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "dist", "webview"),
          vscode.Uri.joinPath(extensionUri, "resources"),
        ],
      },
    );

    // Set icon for the tab (blue heart)
    this._panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icon-light.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icon-dark.svg"),
    };

    // Set the HTML content
    this._panel.webview.html = this._getHtmlContent();

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message) => this._handleMessage(message),
      null,
      this._disposables,
    );

    // Handle panel disposal
    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);

    // Track viewColumn changes (when user drags panel to different group)
    this._panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.viewColumn) {
          this._onDidChangeViewColumnEmitter.fire(e.webviewPanel.viewColumn);
        }
      },
      null,
      this._disposables,
    );
  }

  /**
   * Reveal the panel if it's hidden
   */
  public reveal() {
    this._panel.reveal(this._panel.viewColumn);
  }

  /**
   * Send a message to the chat
   */
  public sendToChat(text: string, context?: EditorContext) {
    this._postMessage({
      type: "sendMessage",
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
      type: "context",
      context,
    });
  }

  private _postMessage(message: unknown) {
    this._panel.webview.postMessage(message);
  }

  private _handleMessage(message: { type: string; [key: string]: unknown }) {
    switch (message.type) {
      case "ready":
        // Webview is ready, send current context
        if (this._currentContext) {
          this._postMessage({
            type: "context",
            context: this._currentContext,
          });
        }
        break;

      case "openFile":
        if (typeof message.path === "string") {
          vscode.workspace.openTextDocument(message.path).then((doc) => {
            vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
          });
        }
        break;

      case "applyEdit":
        if (typeof message.path === "string" && typeof message.content === "string") {
          this._applyEdit({ path: message.path, content: message.content });
        }
        break;

      case "copyToClipboard":
        if (typeof message.text === "string") {
          vscode.env.clipboard.writeText(message.text);
        }
        break;

      case "showInfo":
        if (typeof message.text === "string") {
          vscode.window.showInformationMessage(message.text);
        }
        break;

      case "showError":
        if (typeof message.text === "string") {
          vscode.window.showErrorMessage(message.text);
        }
        break;

      case "openTerminal":
        this.openTerminalBelow();
        break;
    }
  }

  public async openTerminalBelow() {
    this._panel.reveal(vscode.ViewColumn.Beside);
    setTimeout(async () => {
      await vscode.commands.executeCommand("workbench.action.splitEditorDown");
      await vscode.commands.executeCommand("workbench.action.createTerminalEditor");
    }, 100);
  }

  private async _applyEdit(message: { path: string; content: string }) {
    try {
      const doc = await vscode.workspace.openTextDocument(message.path);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));

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
    this._onDidChangeViewColumnEmitter.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private _getHtmlContent(): string {
    const webview = this._panel.webview;
    const config = vscode.workspace.getConfiguration("claudia");
    const gatewayUrl = config.get<string>("gatewayUrl", "ws://localhost:30086/ws");

    // Generate nonce for CSP
    const nonce = crypto.randomBytes(16).toString("hex");

    // Get URIs for bundled webview assets
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "index.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "index.css"),
    );

    // CSP: nonce-based script loading, inline styles for Tailwind
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `connect-src ${gatewayUrl.replace("ws:", "ws:").replace("wss:", "wss:")} ws://localhost:* wss://localhost:*`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join("; ");

    // Get workspace CWD for auto-discover mode
    const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";

    return /* html */ `<!DOCTYPE html>
<html lang="en" data-platform="vscode" data-gateway-url="${gatewayUrl}" data-workspace-cwd="${workspaceCwd}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Claudia</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
