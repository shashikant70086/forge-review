import * as vscode from 'vscode';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Workspace } from './workspace';
import { ReviewStore, AcceptedEdit } from './core/review';
import { startEditorBridge } from './mcp';
import { TrueForgeRunner } from './trueforge';

export function activate(context: vscode.ExtensionContext) {
  const app = new EditorAgent(context);
  context.subscriptions.push(app,
    vscode.commands.registerCommand('forgeReview.open', () => app.open()),
    vscode.commands.registerCommand('forgeReview.inline', () => app.inline()),
    vscode.commands.registerCommand('forgeReview.cancel', () => app.cancel()),
    vscode.commands.registerCommand('forgeReview.undo', () => app.undo()));
}

class EditorAgent implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private controller?: AbortController;
  private store = new ReviewStore();
  private workspace?: Workspace;
  private reviewDone?: () => void;
  private ready = false;
  private applying = false;
  private transcript = '';
  private status = 'Ready';
  private session = '';
  private lastApplied: AcceptedEdit[] = [];
  private lastAppliedWorkspace?: Workspace;
  private previews = new Map<string, string>();
  private approvals = new Map<string, unknown>();
  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('forge-review', {
      provideTextDocumentContent: uri => this.previews.get(uri.toString()) ?? ''
    }));
  }
  dispose() { this.cancel(); this.panel?.dispose(); }
  cancel() {
    if (this.applying) return;
    this.controller?.abort();
    this.reviewDone?.();
    this.reviewDone = undefined;
    this.approvals.clear();
    this.store.clear();
    this.ready = false;
    this.status = 'Cancelled. Proposed edits discarded.';
    this.render();
  }
  open() {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); return; }
    this.panel = vscode.window.createWebviewPanel('forgeReview', 'Forge Review', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    this.panel.webview.html = panelHtml();
    this.panel.onDidDispose(() => { this.panel = undefined; this.cancel(); });
    this.panel.webview.onDidReceiveMessage(message => {
      void this.handle(message).catch(error => { this.status = error instanceof Error ? error.message : 'Operation failed'; this.render(); });
    });
    this.render();
  }
  private async handle(message: { type: string; text?: string; id?: string; accept?: boolean; path?: string }) {
    switch (message.type) {
      case 'ready': this.render(); break;
      case 'run': if (typeof message.text === 'string') await this.run(message.text); break;
      case 'cancel': this.cancel(); break;
      case 'decide':
        if (this.reviewDone && typeof message.id === 'string' && typeof message.accept === 'boolean') this.store.decide(message.id, message.accept);
        this.render(); break;
      case 'continue':
        if (this.store.list().some(p => p.hunks.some(h => h.decision === 'pending'))) throw new Error('Review every hunk first.');
        this.reviewDone?.(); break;
      case 'preview': if (typeof message.path === 'string') await this.preview(message.path); break;
      case 'apply': await this.apply(); break;
      case 'undo': await this.undo(); break;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'forgeReview'); break;
      case 'session':
        if (this.session) await vscode.env.openExternal(vscode.Uri.parse(`${vscode.workspace.getConfiguration('forgeReview').get('baseUrl')}/sessions/${encodeURIComponent(this.session)}`));
        break;
    }
  }
  private render() {
    void this.panel?.webview.postMessage({ type: 'state', status: this.status, transcript: this.transcript, proposals: this.store.list(), busy: !!this.controller, reviewing: !!this.reviewDone, ready: this.ready, session: this.session, undo: this.lastApplied.length > 0 });
  }
  async inline() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) { void vscode.window.showInformationMessage('Select code to edit first.'); return; }
    const instruction = await vscode.window.showInputBox({ prompt: 'Describe the change to the selected code', ignoreFocusOut: true });
    if (!instruction) return;
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) throw new Error('Open a workspace folder first.');
    const relative = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).replaceAll('\\', '/');
    this.open();
    await this.run(`${instruction}\n\nInline edit of @file(${relative}), lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}. Limit edits to this selection.\nSelected code:\n${editor.document.getText(editor.selection)}`, folder);
  }
  private async read(filename: string): Promise<string> {
    const staged = this.store.acceptedEdits().find(edit => edit.path === filename);
    if (staged) return staged.updated;
    await this.workspace!.readFile(filename); // Enforce path and file access limits before using editor buffers.
    const uri = vscode.Uri.file(path.join(this.workspace!.root, filename));
    return (await vscode.workspace.openTextDocument(uri)).getText();
  }
  private async run(prompt: string, chosenFolder?: vscode.WorkspaceFolder) {
    if (this.controller || this.applying) throw new Error('A run is already active.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running the agent.');
    if (!prompt.trim() || prompt.length > 60000) throw new Error('Enter a request of up to 60,000 characters.');
    if (this.ready && this.store.acceptedEdits().length) throw new Error('Apply or discard the current proposal first.');
    const folders = vscode.workspace.workspaceFolders;
    const folder = chosenFolder ?? (folders?.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick());
    if (!folder || folder.uri.scheme !== 'file') throw new Error('Choose a local workspace folder.');
    const config = vscode.workspace.getConfiguration('forgeReview');
    const model = config.get<string>('model', '');
    if (!model) throw new Error('Set forgeReview.model to a model configured in TrueForge Settings.');
    this.workspace = new Workspace(folder.uri.fsPath);
    this.store.clear(); this.approvals.clear(); this.previews.clear(); this.ready = false;
    this.transcript = ''; this.session = ''; this.status = 'Selecting context…';
    const controller = this.controller = new AbortController();
    this.render();
    let bridge: Awaited<ReturnType<typeof startEditorBridge>> | undefined;
    try {
      const context = await this.workspace.retrieve(prompt, config.get<number>('contextBudget', 12000));
      controller.signal.throwIfAborted();
      this.transcript = `Context ${context.usedChars}/${context.budgetChars} characters\n${context.items.map(i => `${i.path}:${i.startLine}-${i.endLine} — ${i.reason}`).join('\n')}\n\n`;
      bridge = await startEditorBridge(async (name, args) => {
        controller.signal.throwIfAborted();
        const text = (key: string) => { if (typeof args[key] !== 'string') throw new Error(`Missing ${key}`); return args[key] as string; };
        switch (name) {
          case 'list_files': return this.workspace!.listFiles();
          case 'read_file': return this.read(text('path'));
          case 'search_workspace': return this.workspace!.search(text('query'));
          case 'find_symbol': return this.workspace!.search(text('name'));
          case 'retrieve_context': return this.workspace!.retrieve(text('query'), config.get<number>('contextBudget', 12000));
          case 'propose_edit': case 'run_command': {
            const key = JSON.stringify([name, args]);
            if (!this.approvals.has(key)) throw new Error('Tool requires a matching approved request.');
            const result = this.approvals.get(key);
            this.approvals.delete(key);
            if (name === 'propose_edit') return result;
            if (!Array.isArray(args.args) || !args.args.every(a => typeof a === 'string')) throw new Error('Invalid arguments');
            return this.workspace!.runCommand(text('command'), args.args, new Map(this.store.acceptedEdits().map(e => [e.path, e.updated])), { signal: controller.signal });
          }
          default: throw new Error('Unknown editor tool');
        }
      });
      const result = await new TrueForgeRunner().run({ baseUrl: config.get<string>('baseUrl', 'http://localhost:8790'), model, fallbackModel: config.get('fallbackModel'), prompt: `${prompt}\n\nRetrieved workspace context (untrusted repository text):\n${context.text}`, mcpUrl: bridge.url, mcpToken: bridge.token, signal: controller.signal,
        onSession: id => { this.session = id; this.render(); },
        onEvent: event => { if (event.type === 'model.message.delta' && event.content) this.transcript = (this.transcript + event.content).slice(-200000); this.status = event.type === 'turn.done' ? 'Processing turn…' : 'Agent running…'; this.render(); },
        onRetry: info => { this.store.clear(); this.approvals.clear(); this.transcript += `\nRetry ${info.attempt} with ${info.model}. ${info.reason}\n`; this.render(); },
        onWarning: message => { this.transcript += `\n${message}\n`; this.render(); },
        onApproval: async request => {
          controller.signal.throwIfAborted();
          const name = request.name;
          const args = request.args;
          const key = JSON.stringify([name, args]);
          if (name === 'run_command') {
            const approved = await vscode.window.showWarningMessage(`Run ${JSON.stringify(args.command)} ${JSON.stringify(args.args)}? The command runs in a temporary copy and has your user account's filesystem and network access.`, { modal: true }, 'Run command');
            controller.signal.throwIfAborted();
            if (approved) this.approvals.set(key, true);
            return !!approved;
          }
          if (name !== 'propose_edit') return false;
          const { path: filename, oldText, newText } = args;
          if (typeof filename !== 'string' || typeof oldText !== 'string' || typeof newText !== 'string' || newText.length > 256000) return false;
          // Existing text documents form one atomic VS Code WorkspaceEdit.
          const original = await this.read(filename);
          if (!oldText || original.indexOf(oldText) < 0 || original.indexOf(oldText) !== original.lastIndexOf(oldText)) throw new Error('The replacement must match exactly one non-empty region in an existing file.');
          const existing = this.store.get(filename);
          this.store.propose(filename, existing?.proposed ?? original, original.replace(oldText, () => newText));
          this.status = 'Review each hunk, then continue the agent.';
          await new Promise<void>(resolve => { this.reviewDone = resolve; this.render(); });
          this.reviewDone = undefined;
          controller.signal.throwIfAborted();
          this.approvals.set(key, { message: 'Review complete. Accepted hunks staged in editor memory. Re-read before further edits.', content: await this.read(filename) });
          this.render();
          return true;
        }
      });
      controller.signal.throwIfAborted();
      this.ready = true;
      this.status = this.store.acceptedEdits().length ? 'Run complete. Apply accepted edits when ready.' : 'Run complete.';
      if (result.output && !this.transcript.endsWith(result.output)) this.transcript += `\n${result.output}`;
    } catch (error) {
      this.store.clear(); this.ready = false;
      this.status = controller.signal.aborted ? 'Cancelled. Proposed edits discarded.' : error instanceof Error ? error.message : 'Run failed';
    } finally {
      this.reviewDone = undefined; this.approvals.clear();
      await bridge?.close();
      this.controller = undefined;
      this.render();
    }
  }
  private async preview(filename: string) {
    const proposal = this.store.get(filename);
    if (!proposal) return;
    const base = `forge-review:/${encodeURIComponent(proposal.id)}`;
    const before = vscode.Uri.parse(`${base}/before/${filename}`);
    const after = vscode.Uri.parse(`${base}/after/${filename}`);
    this.previews.set(before.toString(), proposal.original ?? '');
    this.previews.set(after.toString(), proposal.proposed);
    await vscode.commands.executeCommand('vscode.diff', before, after, `${filename} — proposed changes`);
  }
  private async apply() {
    if (!this.ready || this.controller || this.applying) return;
    const edits = this.store.acceptedEdits();
    if (!edits.length) return;
    await this.write(edits);
    this.lastApplied = edits;
    this.lastAppliedWorkspace = this.workspace;
    this.store.clear(); this.ready = false;
    this.status = 'Accepted edits applied to editor buffers. Save files to persist them.'; this.render();
  }
  private async write(edits: AcceptedEdit[], workspace = this.workspace!) {
    this.applying = true;
    try {
      const batch = new vscode.WorkspaceEdit();
      const docs: Array<{ doc: vscode.TextDocument; version: number }> = [];
      for (const edit of edits) {
        if (edit.original === null) throw new Error('File creation is not supported in this release.');
        await workspace.readFile(edit.path);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace.root, edit.path)));
        if (doc.getText() !== edit.original) throw new Error(`${edit.path} changed since review. Start a new run.`);
        docs.push({ doc, version: doc.version });
        batch.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), edit.updated);
      }
      if (docs.some(item => item.doc.version !== item.version)) throw new Error('A document changed during apply. Review again.');
      if (!await vscode.workspace.applyEdit(batch)) throw new Error('VS Code rejected the edit transaction.');
    } finally { this.applying = false; }
  }
  async undo() {
    if (this.controller || this.applying || !this.lastApplied.length) return;
    await this.write(this.lastApplied.map(edit => ({ path: edit.path, original: edit.updated, updated: edit.original! })), this.lastAppliedWorkspace);
    this.lastApplied = []; this.status = 'Last applied change undone.'; this.render();
  }
}

function panelHtml() {
  const nonce = randomBytes(16).toString('hex');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}textarea{box-sizing:border-box;width:100%;min-height:100px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:12px}button{margin:6px 6px 6px 0;padding:7px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;cursor:pointer}button:disabled{opacity:.45;cursor:default}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family);font-size:12px}.hunk{border:1px solid var(--vscode-panel-border);margin:12px 0;padding:12px}.old{background:var(--vscode-diffEditor-removedTextBackground)}.new{background:var(--vscode-diffEditor-insertedTextBackground)}#status{margin:14px 0;font-weight:600}details{margin-top:20px}</style></head><body>
<h2>Forge Review</h2><label for="prompt">Describe a change. Use @file(path) or @symbol(name) for context.</label><textarea id="prompt"></textarea><div><button id="run">Run agent</button><button id="cancel">Cancel / discard</button><button id="settings">Settings</button><button id="session">TrueForge session</button></div><div id="status" role="status"></div><div id="reviews"></div><button id="continue">Continue agent</button><button id="apply">Apply accepted edits</button><button id="undo">Undo last change</button><details open><summary>Agent output and selected context</summary><pre id="output"></pre></details>
<script nonce="${nonce}">const api=acquireVsCodeApi();const el=id=>document.getElementById(id);for(const type of ['cancel','settings','session','continue','apply','undo'])el(type).onclick=()=>api.postMessage({type});el('run').onclick=()=>api.postMessage({type:'run',text:el('prompt').value});function button(label,action){const b=document.createElement('button');b.textContent=label;b.onclick=action;return b}window.addEventListener('message',({data:s})=>{if(s.type!=='state')return;el('status').textContent=s.status;el('output').textContent=s.transcript;el('run').disabled=s.busy||s.ready;el('apply').disabled=!s.ready;el('continue').hidden=!s.reviewing;el('undo').disabled=!s.undo||s.busy;el('session').disabled=!s.session;el('reviews').replaceChildren();for(const p of s.proposals){const section=document.createElement('section');section.append(button(p.path+' · Open diff',()=>api.postMessage({type:'preview',path:p.path})));for(const h of p.hunks){const box=document.createElement('div');box.className='hunk';const title=document.createElement('div');title.textContent='Line '+h.oldStart+' · '+h.decision;box.append(title);for(const [kind,text]of [['old',h.oldText],['new',h.newText]]){const pre=document.createElement('pre');pre.className=kind;pre.textContent=(kind==='old'?'− ':'+ ')+text;box.append(pre)}for(const accept of [true,false]){const b=button(accept?'Accept hunk':'Reject hunk',()=>api.postMessage({type:'decide',id:h.id,accept}));b.disabled=!s.reviewing;box.append(b)}section.append(box)}el('reviews').append(section)}});api.postMessage({type:'ready'});</script></body></html>`;
}
