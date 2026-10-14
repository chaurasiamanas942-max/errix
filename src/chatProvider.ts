// src/chatProvider.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { streamChat, type ChatMessage } from './openaiClient';
import { recordAndTranscribe } from './voice';
import { resolveProvider } from './provider';
import {
  DEFAULT_SYSTEM_PROMPT,
  ACTION_PROMPTS,
  ActionId,
  EditorContext,
  FileContext,
  buildContextBlock,
  EDIT_SYSTEM_PROMPT
} from './prompts';

const SECRET_KEY = 'errix.apiKey';
const MAX_HISTORY_MESSAGES = 20;
const MAX_FILE_BYTES = 1_000_000;
const MAX_ATTACHED = 20;
const PREVIEW_SCHEME = 'errix-preview';
const EXCLUDE_GLOB = '**/{node_modules,.git,out,dist,build,.next,__pycache__}/**';

type TranscriptItem = { id: string; role: 'user' | 'assistant'; text: string; context?: string };

const HISTORY_KEY = 'errix.conversations';
const MAX_CONVERSATIONS = 100;

type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  transcript: TranscriptItem[];
  history: ChatMessage[];
};

export class ChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'errix.chatView';

  private view?: vscode.WebviewView;
  private ready = false;
  private pending: unknown[] = [];

  private history: ChatMessage[] = [];
  private transcript: TranscriptItem[] = [];
  private abort?: AbortController;
  private busy = false;
  private seq = 0;
  private conversationId = `c${Date.now()}`;
  private inlineBusy = false;
  private previewDocs = new Map<string, string>();

  // Multi-file context state
  private includeOpenTabs = false;
  private attached = new Map<string, vscode.Uri>(); // relative path -> uri

  private readonly _onBusy = new vscode.EventEmitter<boolean>();
  readonly onBusyChange = this._onBusy.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      // Serves the "proposed" side of the inline-edit diff.
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
        provideTextDocumentContent: (uri) => this.previewDocs.get(uri.toString()) ?? ''
      }),
      vscode.commands.registerCommand('errix.inlineEdit', () => this.inlineEdit())
    );
  }

  // ---------------------------------------------------------------------------
  // Webview plumbing
  // ---------------------------------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    view.webview.html = this.renderHtml(view.webview);

    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));

    view.onDidDispose(() => {
      this.abort?.abort();
      this.view = undefined;
      this.ready = false;
    });
  }

  private post(message: unknown): void {
    if (this.view && this.ready) {
      void this.view.webview.postMessage(message);
    } else {
      this.pending.push(message);
    }
  }

  private flushPending(): void {
    this.ready = true;
    const queue = this.pending;
    this.pending = [];
    for (const message of queue) {
      void this.view?.webview.postMessage(message);
    }
  }

  private nextId(): string {
    return `m${++this.seq}`;
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    this._onBusy.fire(value);
    this.post({ type: 'busy', value });
  }

  // ---------------------------------------------------------------------------
  // Messages from the webview
  // ---------------------------------------------------------------------------

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        this.flushPending();
        this.post({ type: 'restore', items: this.transcript });
        this.post({ type: 'busy', value: this.busy });
        this.postAttachments();
        break;

      case 'send':
        await this.send(String(msg.text ?? ''));
        break;

      case 'stop':
        this.abort?.abort();
        break;

      case 'mic':
        await this.voiceInput();
        break;

      case 'newChat':
        this.newChat();
        break;

      case 'insert':
        await this.insertCode(String(msg.code ?? ''));
        break;

      case 'copy':
        await vscode.env.clipboard.writeText(String(msg.code ?? ''));
        this.post({ type: 'toast', text: 'Copied to clipboard' });
        break;

      case 'attach':
        await this.pickFiles();
        break;

      case 'detach':
        this.attached.delete(String(msg.path ?? ''));
        this.postAttachments();
        break;

      case 'tabs':
        this.includeOpenTabs = !!msg.value;
        break;

      case 'historyOpen':
        this.postHistory();
        break;

      case 'historyLoad':
        await this.openConversation(String(msg.id ?? ''));
        break;

      case 'historyDelete':
        await this.deleteConversation(String(msg.id ?? ''));
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (used by commands)
  // ---------------------------------------------------------------------------

  newChat(): void {
    this.abort?.abort();
    this.history = [];
    this.transcript = [];
    this.conversationId = `c${Date.now()}`;
    this.attached.clear();
    this.post({ type: 'clear' });
    this.postAttachments();
  }

  async voiceInput(): Promise<void> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return;

    const config = vscode.workspace.getConfiguration('errix');
    const provider = resolveProvider(apiKey);

    this.post({ type: 'voiceState', value: 'listening' });
    try {
      const text = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Errix: listening in your browser… click the microphone there',
          cancellable: true
        },
        async (_progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          return recordAndTranscribe({
            apiKey,
            baseUrl: provider.baseUrl,
            model: provider.voiceModel,
            language: config.get<string>('voiceLanguage', '').trim() || undefined,
            signal: abort.signal
          });
        }
      );
      if (text) {
        this.post({ type: 'transcript', text });
      } else if (text === '') {
        vscode.window.showWarningMessage('Errix: no speech was detected.');
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Errix: voice input failed. ${(err as Error).message}`);
    } finally {
      this.post({ type: 'voiceState', value: 'idle' });
    }
  }

  async runAction(action: ActionId): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Errix: open a file first.');
      return;
    }

    await vscode.commands.executeCommand('errix.chatView.focus');

    const { label, prompt } = ACTION_PROMPTS[action];
    await this.send(prompt, { display: label, action });
  }

  // ---------------------------------------------------------------------------
  // Core send / stream
  // ---------------------------------------------------------------------------

  private async send(rawText: string, opts: { display?: string; action?: ActionId } = {}): Promise<void> {
    if (this.busy) {
      vscode.window.showWarningMessage('Errix is still responding — press Stop first.');
      return;
    }

    const config = vscode.workspace.getConfiguration('errix');
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      const choice = await vscode.window.showErrorMessage(
        'Errix: no API key configured.',
        'Set API Key'
      );
      if (choice === 'Set API Key') {
        await vscode.commands.executeCommand('errix.setApiKey');
      }
      return;
    }

    const provider = resolveProvider(apiKey);

    const convId = this.conversationId;
    const ctx = this.collectContext();
    const extras = await this.collectExtras(rawText, ctx);
    const contextBlock = buildContextBlock(ctx, extras.files);
    const userContent = contextBlock ? `${contextBlock}\n\n${rawText}` : rawText;

    // Keep code context only on the newest message. Without this, every old turn
    // re-sends all of its files and the token cost grows with each question.
    this.history = this.history.map((m) =>
      m.role === 'user'
        ? { ...m, content: m.content.replace(/<context>[\s\S]*?<\/context>\n\n/, '') }
        : m
    );
    this.history.push({ role: 'user', content: userContent });
    this.trimHistory();

    const userDisplay = opts.display ?? rawText;

    // Label shown under the user's message: exactly which files were sent.
    const labelParts: string[] = [];
    if (ctx) {
      labelParts.push(
        `${ctx.relativePath} · ${ctx.selection ? `lines ${ctx.startLine}–${ctx.endLine}` : 'whole file'}${
          ctx.truncated ? ' · truncated' : ''
        }`
      );
    }
    for (const f of extras.files.slice(0, 5)) {
      labelParts.push(`${f.relativePath}${f.truncated ? ' · truncated' : ''}`);
    }
    if (extras.files.length > 5) {
      labelParts.push(`${extras.files.length - 5} more files`);
    }
    if (extras.skipped.length) {
      const shown = extras.skipped.slice(0, 3).join(', ');
      const more = extras.skipped.length > 3 ? ` and ${extras.skipped.length - 3} more` : '';
      labelParts.push(`⚠ not sent, over budget: ${shown}${more}`);
    }
    const ctxLabel = labelParts.length ? labelParts.join(' + ') : undefined;

    const userId = this.nextId();
    this.transcript.push({ id: userId, role: 'user', text: userDisplay, context: ctxLabel });
    this.post({ type: 'user', id: userId, text: userDisplay, context: ctxLabel });

    const systemPrompt =
      config.get<string>('systemPrompt', '').trim() || DEFAULT_SYSTEM_PROMPT;
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...this.history];

    const assistantId = this.nextId();
    this.post({ type: 'assistantStart', id: assistantId });

    this.setBusy(true);
    this.abort = new AbortController();

    let full = '';
    let errorText: string | undefined;

    try {
      full = await streamChat({
        apiKey,
        baseUrl: provider.baseUrl,
        model: provider.model,
        temperature: config.get<number>('temperature', 0.2),
        messages,
        signal: this.abort.signal,
        onDelta: (delta) => this.post({ type: 'delta', id: assistantId, text: delta })
      });

      this.history.push({ role: 'assistant', content: full });
      this.transcript.push({ id: assistantId, role: 'assistant', text: full });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        errorText = 'Stopped.';
        if (full) {
          this.history.push({ role: 'assistant', content: full });
          this.transcript.push({ id: assistantId, role: 'assistant', text: full });
        }
      } else {
        errorText = e.message || String(err);
      }
    } finally {
      this.abort = undefined;
      this.setBusy(false);
      this.post({ type: 'assistantEnd', id: assistantId, error: errorText });
      if (this.conversationId === convId) {
        await this.saveCurrentConversation();
      }
    }
  }

  private trimHistory(): void {
    if (this.history.length <= MAX_HISTORY_MESSAGES) return;
    this.history = this.history.slice(this.history.length - MAX_HISTORY_MESSAGES);
  }

  // ---------------------------------------------------------------------------
  // Context + editor helpers
  // ---------------------------------------------------------------------------

  private collectContext(): EditorContext | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const doc = editor.document;
    const sel = editor.selection;
    const hasSelection = !!sel && !sel.isEmpty;

    const maxChars = vscode.workspace
      .getConfiguration('errix')
      .get<number>('maxContextChars', 12000);

    let code = hasSelection ? doc.getText(sel) : doc.getText();
    let truncated = false;
    if (code.length > maxChars) {
      code = code.slice(0, maxChars);
      truncated = true;
    }
    if (!code.trim()) return null;

    return {
      fileName: path.basename(doc.fileName),
      relativePath: vscode.workspace.asRelativePath(doc.uri, false),
      languageId: doc.languageId,
      selection: hasSelection,
      startLine: (hasSelection ? sel.start.line : 0) + 1,
      endLine: (hasSelection ? sel.end.line : Math.max(doc.lineCount - 1, 0)) + 1,
      code,
      truncated
    };
  }

  // ---------------------------------------------------------------------------
  // Inline edit: select code -> instruction -> diff preview -> Accept / Reject
  // ---------------------------------------------------------------------------

  async inlineEdit(): Promise<void> {
    if (this.inlineBusy) {
      vscode.window.showWarningMessage(
        'Errix: an edit is already in progress. Accept or reject it first.'
      );
      return;
    }
    this.inlineBusy = true;
    try {
      await this.runInlineEdit();
    } finally {
      this.inlineBusy = false;
    }
  }

  private async runInlineEdit(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage('Errix: select the code you want to change first.');
      return;
    }

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      const choice = await vscode.window.showErrorMessage(
        'Errix: no API key configured.',
        'Set API Key'
      );
      if (choice === 'Set API Key') {
        await vscode.commands.executeCommand('errix.setApiKey');
      }
      return;
    }

    const provider = resolveProvider(apiKey);

    const doc = editor.document;
    const selection = editor.selection;
    const versionAtStart = doc.version;

    const instruction = await vscode.window.showInputBox({
      prompt: 'What should Errix change in the selected code?',
      placeHolder: 'e.g. handle an empty list, add type hints, rename x to total',
      ignoreFocusOut: true
    });
    if (!instruction || !instruction.trim()) return;

    if (vscode.window.activeTextEditor?.document !== doc || !editor.selection.isEqual(selection)) {
      vscode.window.showWarningMessage('Errix: the selection changed. Select the code and try again.');
      return;
    }

    const ctx = this.collectContext();
    if (!ctx || !ctx.selection) {
      vscode.window.showWarningMessage('Errix: the selection is empty.');
      return;
    }
    if (ctx.truncated) {
      vscode.window.showWarningMessage(
        'Errix: the selection is too large to edit safely. Select a smaller region.'
      );
      return;
    }

    // Context: the selection, the whole file for reference (if small), plus any
    // attached files / @mentions / open tabs.
    const config = vscode.workspace.getConfiguration('errix');
    const maxChars = config.get<number>('maxContextChars', 12000);
    const fullText = doc.getText();
    const reference: FileContext[] = [];
    if (fullText.length <= maxChars && fullText.length > ctx.code.length) {
      reference.push({
        relativePath: `${ctx.relativePath} (the full file, for reference only; edit only the selected region)`,
        languageId: ctx.languageId,
        code: fullText,
        truncated: false
      });
    }
    const extras = await this.collectExtras(instruction, {
      ...ctx,
      code: reference.length ? fullText : ctx.code
    });
    const contextBlock = buildContextBlock(ctx, [...reference, ...extras.files]);
    const userContent =
      `${contextBlock}\n\nInstruction: ${instruction.trim()}\n\n` +
      'Return only the replacement for the selected region.';

    let reply: string;
    try {
      reply = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Errix: editing…',
          cancellable: true
        },
        async (_progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          return streamChat({
            apiKey,
            baseUrl: provider.baseUrl,
            model: provider.model,
            temperature: config.get<number>('temperature', 0.2),
            messages: [
              { role: 'system', content: EDIT_SYSTEM_PROMPT },
              { role: 'user', content: userContent }
            ],
            signal: abort.signal,
            onDelta: () => undefined
          });
        }
      );
    } catch (err) {
      const e = err as Error;
      if (e.name !== 'AbortError') {
        vscode.window.showErrorMessage(`Errix: edit failed. ${e.message || String(err)}`);
      }
      return;
    }

    const replacement = this.extractReplacement(reply, ctx.code, doc.eol);
    if (replacement === undefined) {
      vscode.window.showWarningMessage(
        'Errix: the model returned no code. Try rephrasing the instruction.'
      );
      return;
    }
    if (doc.version !== versionAtStart) {
      vscode.window.showWarningMessage(
        'Errix: the file changed while the edit was being prepared. Run the edit again.'
      );
      return;
    }

    // Show the whole file before/after in VS Code's built-in diff editor.
    const startOffset = doc.offsetAt(selection.start);
    const endOffset = doc.offsetAt(selection.end);
    const proposed = fullText.slice(0, startOffset) + replacement + fullText.slice(endOffset);

    const previewUri = vscode.Uri.from({
      scheme: PREVIEW_SCHEME,
      path: `/${ctx.relativePath}`,
      query: String(Date.now())
    });
    this.previewDocs.set(previewUri.toString(), proposed);

    await vscode.commands.executeCommand(
      'vscode.diff',
      doc.uri,
      previewUri,
      `Errix: proposed change to ${ctx.fileName}`
    );

    const decision = await vscode.window.showInformationMessage(
      'Errix: review the highlighted changes. Apply them?',
      'Accept',
      'Reject'
    );

    await this.closePreview(previewUri);
    this.previewDocs.delete(previewUri.toString());

    if (decision !== 'Accept') return;

    if (doc.version !== versionAtStart) {
      vscode.window.showWarningMessage(
        'Errix: the file changed while you were reviewing, so nothing was applied. Run the edit again.'
      );
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(selection.start, selection.end), replacement);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showErrorMessage('Errix: could not apply the change.');
      return;
    }

    const shown = await vscode.window.showTextDocument(doc);
    shown.selection = new vscode.Selection(
      selection.start,
      doc.positionAt(startOffset + replacement.length)
    );
    vscode.window.setStatusBarMessage('Errix: change applied (Ctrl+Z to undo)', 5000);
  }

  /** Pulls the replacement code out of the model reply and matches the file's line endings. */
  private extractReplacement(
    reply: string,
    original: string,
    eol: vscode.EndOfLine
  ): string | undefined {
    const fenced = /```[\w+#.-]*\r?\n([\s\S]*?)```/.exec(reply);
    let code = fenced ? fenced[1] : reply;
    code = code.replace(/\r?\n$/, '');
    if (!code.trim()) return undefined;
    if (/\r?\n$/.test(original)) code += '\n';
    return code.replace(/\r?\n/g, eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
  }

  private async closePreview(previewUri: vscode.Uri): Promise<void> {
    const target = previewUri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.modified.toString() === target
        ) {
          await vscode.window.tabGroups.close(tab);
          return;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Saved conversations (history + search)
  // ---------------------------------------------------------------------------

  private loadConversations(): Conversation[] {
    return this.context.globalState.get<Conversation[]>(HISTORY_KEY, []);
  }

  private async saveCurrentConversation(): Promise<void> {
    if (this.transcript.length === 0) return;

    const firstUser = this.transcript.find((t) => t.role === 'user');
    const title = (firstUser?.text ?? 'Untitled chat').replace(/\s+/g, ' ').slice(0, 60);

    // Saved copies carry no attached code (only the questions and answers), so
    // storage stays small and a resumed chat gets fresh context on the next message.
    const history = this.history.map((m) =>
      m.role === 'user'
        ? { ...m, content: m.content.replace(/<context>[\s\S]*?<\/context>\n\n/, '') }
        : m
    );

    const entry: Conversation = JSON.parse(
      JSON.stringify({
        id: this.conversationId,
        title,
        updatedAt: Date.now(),
        transcript: this.transcript,
        history
      })
    );

    const others = this.loadConversations().filter((c) => c.id !== this.conversationId);
    await this.context.globalState.update(
      HISTORY_KEY,
      [entry, ...others].slice(0, MAX_CONVERSATIONS)
    );
  }

  private postHistory(): void {
    this.post({
      type: 'historyList',
      items: this.loadConversations().map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        count: c.transcript.length,
        // Lower-cased text the panel searches through (capped to keep messages small).
        searchText: c.transcript.map((t) => t.text).join('\n').toLowerCase().slice(0, 6000)
      }))
    });
  }

  private async openConversation(id: string): Promise<void> {
    if (this.busy) {
      vscode.window.showWarningMessage('Errix is still responding — press Stop first.');
      return;
    }
    const found = this.loadConversations().find((c) => c.id === id);
    if (!found) return;

    this.conversationId = found.id;
    this.history = found.history;
    this.transcript = found.transcript;
    this.attached.clear();
    this.post({ type: 'restore', items: this.transcript });
    this.postAttachments();
  }

  private async deleteConversation(id: string): Promise<void> {
    const rest = this.loadConversations().filter((c) => c.id !== id);
    await this.context.globalState.update(HISTORY_KEY, rest);
    if (id === this.conversationId) {
      this.newChat();
    }
    this.postHistory();
  }

  // ---------------------------------------------------------------------------
  // Multi-file context: @mentions, attached files, open tabs
  // ---------------------------------------------------------------------------

  private postAttachments(): void {
    this.post({
      type: 'attachments',
      items: [...this.attached.keys()],
      tabs: this.includeOpenTabs
    });
  }

  private async pickFiles(): Promise<void> {
    const uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, 5000);
    const items = uris
      .map((uri) => ({ label: vscode.workspace.asRelativePath(uri, false), uri }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Pick files to attach to the chat'
    });
    if (!picked) return;

    let added = 0;
    for (const p of picked) {
      if (!this.attached.has(p.label) && this.attached.size >= MAX_ATTACHED) break;
      this.attached.set(p.label, p.uri);
      added++;
    }
    if (added < picked.length) {
      vscode.window.showWarningMessage(
        `Errix: attached ${added} of ${picked.length} files. The limit is ${MAX_ATTACHED} per chat, so pick the files that matter most.`
      );
    }
    this.postAttachments();
  }

  /** Finds files named in the message with @path or @filename. */
  private async resolveMentions(text: string): Promise<vscode.Uri[]> {
    const tokens: string[] = [];
    const re = /(?:^|\s)@([\w./\\-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && tokens.length < 8) {
      tokens.push(m[1]);
    }

    const found: vscode.Uri[] = [];
    for (const token of tokens) {
      const matches = await vscode.workspace.findFiles(
        `**/${token.replace(/\\/g, '/')}`,
        EXCLUDE_GLOB,
        1
      );
      if (matches[0]) found.push(matches[0]);
    }
    return found;
  }

  /**
   * Reads one file within the remaining character budget.
   * Returns null for unreadable/binary/empty files, 'skipped' when it does not fit.
   */
  private async readFileContext(
    uri: vscode.Uri,
    budget: number,
    allowTruncate: boolean
  ): Promise<FileContext | 'skipped' | null> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) return 'skipped';

      const doc = await vscode.workspace.openTextDocument(uri);
      let code = doc.getText();
      if (!code.trim()) return null;

      let truncated = false;
      if (code.length > budget) {
        // Explicitly requested files may be cut to fit; open tabs are all-or-nothing.
        if (!allowTruncate || budget < 2000) return 'skipped';
        code = code.slice(0, budget);
        truncated = true;
      }

      return {
        relativePath: vscode.workspace.asRelativePath(uri, false),
        languageId: doc.languageId,
        code,
        truncated
      };
    } catch {
      return null; // binary or unreadable file
    }
  }

  /** Collects extra files in priority order: @mentions, attached files, open tabs. */
  private async collectExtras(
    rawText: string,
    active: EditorContext | null
  ): Promise<{ files: FileContext[]; skipped: string[] }> {
    const totalBudget = vscode.workspace
      .getConfiguration('errix')
      .get<number>('maxTotalContextChars', 24000);
    let remaining = totalBudget - (active ? active.code.length : 0);

    const candidates: { uri: vscode.Uri; explicit: boolean }[] = [];

    for (const uri of await this.resolveMentions(rawText)) {
      candidates.push({ uri, explicit: true });
    }
    for (const uri of this.attached.values()) {
      candidates.push({ uri, explicit: true });
    }
    if (this.includeOpenTabs) {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputText) {
            candidates.push({ uri: tab.input.uri, explicit: false });
          }
        }
      }
    }

    const activeKey = vscode.window.activeTextEditor?.document.uri.toString();
    const seen = new Set<string>(activeKey ? [activeKey] : []);
    const files: FileContext[] = [];
    const skipped: string[] = [];

    for (const { uri, explicit } of candidates) {
      const key = uri.toString();
      if (seen.has(key) || uri.scheme !== 'file') continue;
      seen.add(key);

      if (remaining <= 0) {
        skipped.push(vscode.workspace.asRelativePath(uri, false));
        continue;
      }

      const result = await this.readFileContext(uri, remaining, explicit);
      if (result === null) continue;
      if (result === 'skipped') {
        skipped.push(vscode.workspace.asRelativePath(uri, false));
        continue;
      }

      files.push(result);
      remaining -= result.code.length;
    }

    return { files, skipped };
  }

  private async insertCode(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Errix: open a file to insert into.');
      return;
    }

    const selection = editor.selection;
    const ok = await editor.edit((builder) => {
      if (selection && !selection.isEmpty) {
        builder.replace(selection, code);
      } else {
        builder.insert(selection.active, code);
      }
    });

    if (!ok) {
      vscode.window.showErrorMessage('Errix: could not insert code.');
      return;
    }
    this.post({ type: 'toast', text: 'Inserted' });
  }

  // ---------------------------------------------------------------------------
  // API key
  // ---------------------------------------------------------------------------

    private async getApiKey(): Promise<string | undefined> {
    // 1. Bring your own key: unlimited, goes straight to your provider.
    const fromSecrets = await this.context.secrets.get(SECRET_KEY);
    if (fromSecrets) return fromSecrets;

    const fromSettings = vscode.workspace
      .getConfiguration('errix')
      .get<string>('apiKey', '')
      .trim();
    if (fromSettings) return fromSettings;

    // 2. Errix Cloud: one-click GitHub sign-in with free daily limits.
    try {
      const session = await vscode.authentication.getSession('github', ['read:user'], {
        createIfNone: true
      });
      return session.accessToken;
    } catch {
      return undefined; // the person closed the sign-in prompt
    }
  }
  // ---------------------------------------------------------------------------
  // Webview HTML
  // ---------------------------------------------------------------------------

  private renderHtml(webview: vscode.Webview): string {
    const asset = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    const scriptUri = asset('chat.js');
    const voiceUri = asset('voice.js');
    const styleUri = asset('chat.css');
    const overridesUri = asset('overrides.css');

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource}`,
      `script-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${overridesUri}" rel="stylesheet" />
  <title>Errix</title>
</head>
<body>
  <header class="topbar">
    <button id="history-btn" class="icon-btn" title="Chats" aria-label="Chats">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
    </button>
    <span class="title">Errix</span>
  </header>

  <div id="history" class="history">
    <button id="new-chat" class="new-chat-row" title="Start a new chat">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      <span>New chat</span>
    </button>
    <input id="history-search" class="history-search" type="text" placeholder="Search past chats…" />
    <div id="history-list" class="history-list"></div>
  </div>

  <div id="messages" class="messages"></div>

  <div class="composer">
    <div id="attachments" class="attachments"></div>
    <textarea id="input" rows="1" placeholder="Ask Errix…  (type @filename to mention a file)"></textarea>
    <div class="composer-actions">
      <button id="attach" class="icon-btn" title="Attach files to this chat" aria-label="Attach files">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <label class="tabs-toggle" title="Send all open tabs as context">
        <input type="checkbox" id="tabs" /> Open tabs
      </label>
      <span class="spacer"></span>
      <button id="stop" class="icon-btn" hidden title="Stop" aria-label="Stop">
        <svg viewBox="0 0 24 24" width="16" height="16"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>
      </button>
      <button id="send" class="send-btn" title="Send" aria-label="Send">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      </button>
    </div>
  </div>

  <div id="toast" class="toast"></div>
  
  <script src="${voiceUri}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}