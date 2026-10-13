import * as vscode from 'vscode';
import { ChatProvider } from './chatProvider';

const SECRET_KEY = 'errix.apiKey';

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatProvider(context);

  // --- Side panel (activity bar) -------------------------------------------
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // --- Status bar ----------------------------------------------------------
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'errix.focus';
  status.text = '$(sparkle) Errix';
  status.tooltip = 'Open Errix chat';
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    provider.onBusyChange((busy) => {
      status.text = busy ? '$(sync~spin) Errix' : '$(sparkle) Errix';
      status.tooltip = busy ? 'Errix is thinking…' : 'Open Errix chat';
    })
  );

  // --- Commands ------------------------------------------------------------
  const register = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('errix.focus', async () => {
    await vscode.commands.executeCommand('errix.chatView.focus');
  });

  register('errix.newChat', async () => {
    await vscode.commands.executeCommand('errix.chatView.focus');
    provider.newChat();
  });
  register('errix.voice', async () => {
    await vscode.commands.executeCommand('errix.chatView.focus');
    await provider.voiceInput();
  });

  register('errix.explain', () => provider.runAction('explain'));
  register('errix.refactor', () => provider.runAction('refactor'));
  register('errix.generateTests', () => provider.runAction('generateTests'));
  register('errix.fix', () => provider.runAction('fix'));

  register('errix.setApiKey', async () => {
    const value = await vscode.window.showInputBox({
      title: 'Errix: API Key',
      prompt: 'Stored in VS Code SecretStorage (OS keychain), not in settings.json.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-…'
    });
    if (value === undefined) return;
    if (!value.trim()) {
      await context.secrets.delete(SECRET_KEY);
      vscode.window.showInformationMessage('Errix: API key cleared.');
      return;
    }
    await context.secrets.store(SECRET_KEY, value.trim());
    vscode.window.showInformationMessage('Errix: API key saved.');
  });

  register('errix.clearApiKey', async () => {
    await context.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('Errix: API key cleared.');
  });
}

export function deactivate() {
  /* nothing to clean up */
}