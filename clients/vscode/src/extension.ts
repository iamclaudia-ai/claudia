import * as vscode from 'vscode';
import { ClaudiaPanelProvider } from './ClaudiaPanelProvider';
import { getEditorContext } from './context';

let claudiaPanel: ClaudiaPanelProvider | undefined;

// Local settings file (gitignored via *.local.json pattern)
const LOCAL_SETTINGS_FILE = '.vscode/settings.local.json';

interface LocalSettings {
  [key: string]: unknown;
  'claudia.openOnStartup'?: boolean;
  'claudia.viewColumn'?: number;
}

// Read local settings from .vscode/settings.local.json
async function getLocalSettings(): Promise<LocalSettings> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return {};

  try {
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, LOCAL_SETTINGS_FILE);
    const data = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(data.toString());
  } catch {
    return {};
  }
}

// Save a key to .vscode/settings.local.json (merges with existing)
async function saveLocalSetting(key: string, value: unknown): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;

  try {
    // Ensure .vscode directory exists
    const vscodeDir = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode');
    try {
      await vscode.workspace.fs.stat(vscodeDir);
    } catch {
      await vscode.workspace.fs.createDirectory(vscodeDir);
    }

    const current = await getLocalSettings();
    current[key] = value;

    const uri = vscode.Uri.joinPath(workspaceFolder.uri, LOCAL_SETTINGS_FILE);
    const data = Buffer.from(JSON.stringify(current, null, 2));
    await vscode.workspace.fs.writeFile(uri, data);
  } catch (error) {
    console.error('Failed to save Claudia local settings:', error);
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Claudia extension activated');

  // Register command to open the chat panel
  context.subscriptions.push(
    vscode.commands.registerCommand('claudia.openChat', async (targetViewColumn?: vscode.ViewColumn) => {
      if (claudiaPanel) {
        claudiaPanel.reveal();
      } else {
        // Use saved viewColumn, provided viewColumn, or default to Beside
        const settings = await getLocalSettings();
        const viewColumn = targetViewColumn
          ?? (settings['claudia.viewColumn'] as vscode.ViewColumn)
          ?? vscode.ViewColumn.Beside;

        claudiaPanel = new ClaudiaPanelProvider(context.extensionUri, viewColumn);

        // Track when panel's viewColumn changes - save to local settings
        claudiaPanel.onDidChangeViewColumn(async (newColumn) => {
          await saveLocalSetting('claudia.viewColumn', newColumn);
        });

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

  // Auto-open on startup if configured via .vscode/settings.local.json
  (async () => {
    const settings = await getLocalSettings();
    if (settings['claudia.openOnStartup'] === true) {
      // Wait for VS Code to fully initialize, then restore Claudia in saved position
      setTimeout(() => {
        console.log('Claudia auto-open: viewColumn =', settings['claudia.viewColumn']);
        vscode.commands.executeCommand('claudia.openChat', settings['claudia.viewColumn']);
      }, 1500);
    }
  })();
}

export function deactivate() {
  console.log('Claudia extension deactivated');
}
