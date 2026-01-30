import * as vscode from 'vscode';
import { ClaudiaPanelProvider } from './ClaudiaPanelProvider';
import { getEditorContext } from './context';

let claudiaPanel: ClaudiaPanelProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('Claudia extension activated');

  // Register command to open the chat panel
  context.subscriptions.push(
    vscode.commands.registerCommand('claudia.openChat', () => {
      if (claudiaPanel) {
        claudiaPanel.reveal();
      } else {
        claudiaPanel = new ClaudiaPanelProvider(context.extensionUri);
        claudiaPanel.onDidDispose(() => {
          claudiaPanel = undefined;
        });
      }

      // Send current context
      if (vscode.window.activeTextEditor) {
        const ctx = getEditorContext(vscode.window.activeTextEditor);
        claudiaPanel?.updateContext(ctx);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudia.sendSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection);
      if (!selection) return;

      // Open panel if not open
      if (!claudiaPanel) {
        vscode.commands.executeCommand('claudia.openChat');
      }

      const ctx = getEditorContext(editor);
      claudiaPanel?.sendToChat(selection, ctx);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudia.explainCode', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection);
      if (!selection) return;

      // Open panel if not open
      if (!claudiaPanel) {
        vscode.commands.executeCommand('claudia.openChat');
      }

      const ctx = getEditorContext(editor);
      claudiaPanel?.sendToChat(`Explain this code:\n\n\`\`\`${ctx.languageId}\n${selection}\n\`\`\``, ctx);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudia.fixCode', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection);
      if (!selection) return;

      // Open panel if not open
      if (!claudiaPanel) {
        vscode.commands.executeCommand('claudia.openChat');
      }

      const ctx = getEditorContext(editor);
      const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
        .filter(d => editor.selection.contains(d.range))
        .map(d => `- ${d.message}`)
        .join('\n');

      let prompt = `Fix this code:\n\n\`\`\`${ctx.languageId}\n${selection}\n\`\`\``;
      if (diagnostics) {
        prompt += `\n\nDiagnostics:\n${diagnostics}`;
      }

      claudiaPanel?.sendToChat(prompt, ctx);
    })
  );

  // Track active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && claudiaPanel) {
        const ctx = getEditorContext(editor);
        claudiaPanel.updateContext(ctx);
      }
    })
  );

  // Track selection changes
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (claudiaPanel) {
        const ctx = getEditorContext(event.textEditor);
        claudiaPanel.updateContext(ctx);
      }
    })
  );
}

export function deactivate() {
  console.log('Claudia extension deactivated');
}
