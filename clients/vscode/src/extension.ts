import * as vscode from 'vscode';
import { ClaudiaViewProvider } from './ClaudiaViewProvider';
import { getEditorContext } from './context';

let claudiaProvider: ClaudiaViewProvider;

export function activate(context: vscode.ExtensionContext) {
  console.log('Claudia extension activated');

  // Create the webview provider
  claudiaProvider = new ClaudiaViewProvider(context.extensionUri);

  // Register the webview provider for the sidebar
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'claudia.chat',
      claudiaProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudia.openChat', () => {
      vscode.commands.executeCommand('claudia.chat.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudia.sendSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection);
      if (!selection) return;

      const ctx = getEditorContext(editor);
      claudiaProvider.sendToChat(selection, ctx);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudia.explainCode', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection);
      if (!selection) return;

      const ctx = getEditorContext(editor);
      claudiaProvider.sendToChat(`Explain this code:\n\n\`\`\`${ctx.languageId}\n${selection}\n\`\`\``, ctx);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudia.fixCode', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection);
      if (!selection) return;

      const ctx = getEditorContext(editor);
      const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
        .filter(d => editor.selection.contains(d.range))
        .map(d => `- ${d.message}`)
        .join('\n');

      let prompt = `Fix this code:\n\n\`\`\`${ctx.languageId}\n${selection}\n\`\`\``;
      if (diagnostics) {
        prompt += `\n\nDiagnostics:\n${diagnostics}`;
      }

      claudiaProvider.sendToChat(prompt, ctx);
    })
  );

  // Track active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        const ctx = getEditorContext(editor);
        claudiaProvider.updateContext(ctx);
      }
    })
  );

  // Track selection changes
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const ctx = getEditorContext(event.textEditor);
      claudiaProvider.updateContext(ctx);
    })
  );

  // Send initial context
  if (vscode.window.activeTextEditor) {
    const ctx = getEditorContext(vscode.window.activeTextEditor);
    claudiaProvider.updateContext(ctx);
  }
}

export function deactivate() {
  console.log('Claudia extension deactivated');
}
