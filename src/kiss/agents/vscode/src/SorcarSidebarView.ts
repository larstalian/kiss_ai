/**
 * Sidebar chat view for Sorcar.
 * Provides a WebviewViewProvider that renders the chat UI in the
 * VS Code secondary sidebar.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {AgentProcess} from './AgentProcess';
import {MergeManager} from './MergeManager';
import {
  getDefaultModel,
  hasAnyConfiguredApiKeys,
  installCodexCli,
} from './DependencyInstaller';
import {buildChatHtml} from './SorcarTab';
import {CodexBackend} from './CodexBackend';
import {findCodexPath} from './CodexBinary';
import {AgentProcessKissSessionStore} from './KissSessionStore';
import {
  FromWebviewMessage,
  ToWebviewMessage,
  Attachment,
  AgentCommand,
  BackendId,
  CodexReasoningEffort,
  CodexServiceTier,
} from './types';

/**
 * WebviewViewProvider for the KISS Sorcar chat in the secondary sidebar.
 *
 * Hosts the chat HTML/JS/CSS interface with its own AgentProcess.
 */
export class SorcarSidebarView implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  /** Per-tab task processes. Created on submit, disposed on next submit. */
  private _taskProcesses: Map<string, AgentProcess> = new Map();
  /** Shared service process for non-task commands (getModels, etc.). */
  private _serviceProcess: AgentProcess | null = null;
  /** The currently active tab ID (updated on every message with tabId). */
  private _activeTabId: string = '';
  private _extensionUri: vscode.Uri;
  private _selectedModel: string;
  private _thinkingEffort: CodexReasoningEffort = 'medium';
  private _codexServiceTier: CodexServiceTier = 'standard';
  private _activeBackend: BackendId;
  private readonly _stateStore: vscode.Memento;
  private _codexBackends: Map<string, CodexBackend> = new Map();
  private _runningTabs: Set<string> = new Set();
  private _webviewHasFocus: boolean = false;

  /** Per-tab MergeManager instances — each tab gets its own merge review. */
  private _mergeManagers: Map<string, MergeManager> = new Map();
  private _onCommitMessage = new vscode.EventEmitter<{
    message: string;
    error?: string;
  }>();
  public readonly onCommitMessage = this._onCommitMessage.event;
  private _commitPendingTabs: Set<string> = new Set();
  private _worktreeDirs: Map<string, string> = new Map();
  private _worktreeActionResolves: Map<string, () => void> = new Map();
  private _worktreeProgresses: Map<
    string,
    vscode.Progress<{message?: string}>
  > = new Map();
  private _autocommitActionResolves: Map<string, () => void> = new Map();
  private _autocommitProgresses: Map<
    string,
    vscode.Progress<{message?: string}>
  > = new Map();
  private _mergeBackends: Map<string, BackendId> = new Map();
  private _mergeTotalHunks: Map<string, number> = new Map();
  private _disposed: boolean = false;
  private _preMergeOpenFiles: Map<string, Set<string>> = new Map();
  private _restoreChain: Promise<void> = Promise.resolve();
  private _onFirstResolve: (() => void) | undefined;

  /**
   * Show a notification-progress dialog with a timeout-based auto-resolve.
   *
   * Stores the progress reporter and resolve callback in the given maps
   * so that incoming backend events can update the message or complete
   * the dialog.  If no completion event arrives within *timeoutMs* the
   * dialog is automatically dismissed.
   */
  private _showActionProgress(
    title: string,
    tabId: string | undefined,
    progressMap: Map<string, vscode.Progress<{message?: string}>>,
    resolveMap: Map<string, () => void>,
    timeoutMs: number = 120_000,
  ): void {
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
      },
      progress => {
        if (tabId !== undefined) {
          progressMap.set(tabId, progress);
        }
        return new Promise<void>(resolve => {
          if (tabId !== undefined) {
            resolveMap.set(tabId, resolve);
          }
          setTimeout(() => {
            if (tabId !== undefined && resolveMap.get(tabId) === resolve) {
              resolveMap.delete(tabId);
              resolve();
            }
          }, timeoutMs);
        });
      },
    );
  }

  /** Resolve all pending worktree/autocommit action promises and clear maps. */
  private _resolveAllWorktreeActions(): void {
    for (const resolve of this._worktreeActionResolves.values()) resolve();
    this._worktreeActionResolves.clear();
    this._worktreeProgresses.clear();
    for (const resolve of this._autocommitActionResolves.values()) resolve();
    this._autocommitActionResolves.clear();
    this._autocommitProgresses.clear();
  }

  /**
   * Register a one-time callback invoked when the webview view is first resolved.
   *
   * Used by the extension entry point to widen the secondary sidebar on
   * first activation.
   */
  public onFirstResolve(cb: () => void): void {
    this._onFirstResolve = cb;
  }

  constructor(extensionUri: vscode.Uri, stateStore: vscode.Memento) {
    this._extensionUri = extensionUri;
    this._stateStore = stateStore;
    this._activeBackend = stateStore.get<BackendId>(
      'kissSorcar.activeBackend',
      'apiKey',
    );
    this._selectedModel =
      vscode.workspace
        .getConfiguration('kissSorcar')
        .get<string>('defaultModel') || getDefaultModel();
  }

  private _rememberThinkingEffort(effort: unknown): void {
    if (
      effort === 'low' ||
      effort === 'medium' ||
      effort === 'high' ||
      effort === 'xhigh'
    ) {
      this._thinkingEffort = effort;
    }
  }

  private _rememberCodexServiceTier(tier: unknown): void {
    if (tier === 'fast') {
      this._codexServiceTier = 'fast';
    } else if (tier === 'standard' || tier === 'flex') {
      this._codexServiceTier = 'standard';
    }
  }

  /**
   * Get or create a MergeManager for the given tab.
   *
   * Each tab gets its own MergeManager so multiple tabs can show
   * their merge/diff UI concurrently without interfering.
   */
  private _getOrCreateMergeManager(tabId: string): MergeManager {
    const existing = this._mergeManagers.get(tabId);
    if (existing) return existing;
    const mgr = new MergeManager();
    this._mergeManagers.set(tabId, mgr);
    mgr.on('hunkProcessed', () => {
      this._sendToWebview({
        type: 'merge_nav',
        remaining: mgr.totalHunks,
        total: this._mergeTotalHunks.get(tabId) ?? mgr.totalHunks,
        tabId,
      });
    });
    mgr.on('allDone', () => {
      this._mergeManagers.delete(tabId);
      this._mergeTotalHunks.delete(tabId);
      const backend = this._mergeBackends.get(tabId) || this._activeBackend;
      this._mergeBackends.delete(tabId);
      mgr.dispose();
      if (backend === 'codex') {
        void this._getCodexBackend(tabId).finishMerge(tabId);
      } else {
        this.sendMergeAllDone(tabId);
      }
      this._restoreChain = this._restoreChain
        .then(() => this._restorePreMergeEditors(tabId))
        .catch(err => {
          console.error(
            '[SorcarSidebarView] restorePreMergeEditors failed:',
            err,
          );
        });
    });
    return mgr;
  }

  private _handleMergeData(msg: ToWebviewMessage): void {
    if (msg.type !== 'merge_data') return;
    const mergeTabId = msg.tabId;
    if (mergeTabId === undefined) return;
    const mgr = this._getOrCreateMergeManager(mergeTabId);
    this._mergeBackends.set(mergeTabId, this._activeBackend);
    this._mergeTotalHunks.set(mergeTabId, msg.hunk_count);
    this._restoreChain = this._restoreChain
      .then(async () => {
        if (!this._preMergeOpenFiles.has(mergeTabId)) {
          this._preMergeOpenFiles.set(mergeTabId, this._getOpenEditorFiles());
        }
        await mgr.openMerge(msg.data);
        this._sendToWebview({
          type: 'merge_nav',
          remaining: mgr.totalHunks,
          total: this._mergeTotalHunks.get(mergeTabId) ?? mgr.totalHunks,
          tabId: mergeTabId,
        });
      })
      .catch(err => {
        console.error(
          '[SorcarSidebarView] openMerge failed for tab',
          mergeTabId,
          err,
        );
      });
  }

  /**
   * Get or create the shared service process for non-task commands.
   *
   * The service process handles global commands (getModels, getHistory,
   * getFiles, complete, etc.) and per-tab state commands (resumeSession,
   * getAdjacentTask) when no task process exists for that tab.
   */
  private _getServiceProcess(): AgentProcess {
    if (this._serviceProcess) return this._serviceProcess;
    this._serviceProcess = new AgentProcess('__service__');
    this._setupProcessListeners(this._serviceProcess, '');
    this._serviceProcess.start(this._getWorkDir());
    return this._serviceProcess;
  }

  /**
   * Get the best process for a specific tab.
   *
   * Returns the tab's task process if one exists (it has the tab's
   * per-tab agent state from the most recent task), otherwise falls
   * back to the shared service process.
   */
  private _getTabProcess(tabId: string): AgentProcess {
    return this._taskProcesses.get(tabId) || this._getServiceProcess();
  }

  /**
   * Create a fresh task process for a new task in the given tab.
   *
   * Disposes any existing task process for that tab first, ensuring
   * each task runs in a clean, isolated Python subprocess.
   */
  private _createTaskProcess(tabId: string): AgentProcess {
    const old = this._taskProcesses.get(tabId);
    if (old) {
      old.dispose();
      this._taskProcesses.delete(tabId);
    }
    const proc = new AgentProcess(tabId);
    this._taskProcesses.set(tabId, proc);
    this._setupProcessListeners(proc, tabId);
    return proc;
  }

  /**
   * Set up event listeners on a per-tab AgentProcess.
   *
   * Handles all message types (merge, worktree, status, etc.) and
   * forwards them to the webview. Injects tabId into messages that
   * don't already have one.
   */
  private _setupProcessListeners(proc: AgentProcess, tabId: string): void {
    proc.on('message', (msg: ToWebviewMessage) => {
      // Inject tabId if the Python side didn't set it
      if (msg.tabId === undefined && tabId) {
        msg.tabId = tabId;
      }

      if (msg.type === 'commitMessage') {
        this._onCommitMessage.fire({message: msg.message, error: msg.error});
      }
      if (msg.type === 'models' && msg.selected) {
        this._selectedModel = msg.selected;
      }
      this._handleMergeData(msg);
      if (msg.type === 'worktree_created' || msg.type === 'worktree_done') {
        const dir = msg.worktreeDir;
        const wtTabId = msg.tabId;
        if (dir) {
          if (wtTabId !== undefined) {
            this._worktreeDirs.set(wtTabId, dir);
          }
          void this._openWorktreeInScm(dir);
        }
      }
      if (msg.type === 'worktree_progress') {
        const wpTabId = msg.tabId;
        const progress =
          wpTabId !== undefined
            ? this._worktreeProgresses.get(wpTabId)
            : this._worktreeProgresses.values().next().value;
        if (progress) {
          progress.report({message: msg.message});
        }
      }
      if (msg.type === 'worktree_result') {
        const wrTabId = msg.tabId;
        if (wrTabId !== undefined) {
          const resolve = this._worktreeActionResolves.get(wrTabId);
          if (resolve) {
            resolve();
            this._worktreeActionResolves.delete(wrTabId);
          }
          this._worktreeProgresses.delete(wrTabId);
        } else {
          // Fallback: resolve all pending
          this._resolveAllWorktreeActions();
        }
        if (msg.success) {
          vscode.window.showInformationMessage(
            msg.message || 'Worktree action completed.',
          );
        } else {
          vscode.window.showErrorMessage(
            msg.message || 'Worktree action failed.',
          );
        }
        if (msg.success && wrTabId !== undefined) {
          const wtDir = this._worktreeDirs.get(wrTabId);
          if (wtDir) {
            void this._closeWorktreeInScm(wtDir);
            this._worktreeDirs.delete(wrTabId);
          }
        }
      }
      if (msg.type === 'autocommit_progress') {
        const apTabId = msg.tabId;
        const progress =
          apTabId !== undefined
            ? this._autocommitProgresses.get(apTabId)
            : this._autocommitProgresses.values().next().value;
        if (progress) {
          progress.report({message: msg.message});
        }
      }
      if (msg.type === 'autocommit_done') {
        const adTabId = msg.tabId;
        if (adTabId !== undefined) {
          const resolve = this._autocommitActionResolves.get(adTabId);
          if (resolve) {
            resolve();
            this._autocommitActionResolves.delete(adTabId);
          }
          this._autocommitProgresses.delete(adTabId);
        }
        if (msg.success) {
          vscode.window.showInformationMessage(
            msg.message || 'Auto-commit completed.',
          );
        } else {
          vscode.window.showErrorMessage(msg.message || 'Auto-commit failed.');
        }
      }

      // Reveal the sidebar when the agent asks a question so the user
      // sees the modal even if they switched to another panel.
      if (msg.type === 'askUser' && this._view) {
        this._view.show(true);
      }

      this._sendToWebview(msg);
      if (msg.type === 'status') {
        const statusTabId = msg.tabId;
        if (msg.running) {
          if (statusTabId !== undefined) this._runningTabs.add(statusTabId);
        } else {
          if (statusTabId !== undefined) this._runningTabs.delete(statusTabId);
          if (this._commitPendingTabs.size > 0) {
            this._onCommitMessage.fire({message: '', error: 'Process stopped'});
          }
        }
      }
    });
  }

  private _getCodexBackend(tabId: string): CodexBackend {
    const key = tabId || '__default__';
    const existing = this._codexBackends.get(key);
    if (existing) return existing;

    const process = new AgentProcess(key);
    const store = new AgentProcessKissSessionStore(process, key);
    const backend = new CodexBackend(
      this._stateStore,
      undefined,
      () => !!findCodexPath(),
      store,
      true,
    );
    this._codexBackends.set(key, backend);
    backend.events.on('message', (msg: ToWebviewMessage) => {
      if (msg.tabId === undefined && key !== '__default__') {
        msg.tabId = key;
      }
      if (msg.type === 'backendState') {
        this._sendToWebview(msg);
        return;
      }
      if (this._activeBackend !== 'codex') return;
      if (msg.type === 'commitMessage') {
        this._onCommitMessage.fire({message: msg.message, error: msg.error});
      }
      if (msg.type === 'models' && msg.selected) {
        this._selectedModel = msg.selected;
      }
      this._handleMergeData(msg);
      this._sendToWebview(msg);
      if (msg.type === 'status') {
        const statusTabId = msg.tabId;
        if (msg.running) {
          if (statusTabId !== undefined) this._runningTabs.add(statusTabId);
        } else {
          if (statusTabId !== undefined) this._runningTabs.delete(statusTabId);
          if (this._commitPendingTabs.size > 0) {
            this._onCommitMessage.fire({message: '', error: 'Process stopped'});
          }
        }
      }
    });
    return backend;
  }

  private async _refreshBackendState(tabId = this._activeTabId): Promise<void> {
    if (this._activeBackend === 'codex' && !findCodexPath()) {
      this._activeBackend = 'apiKey';
      await this._stateStore.update('kissSorcar.activeBackend', 'apiKey');
    }
    this._getCodexBackend(tabId || '__default__').setActiveBackend(
      this._activeBackend,
      hasAnyConfiguredApiKeys(),
    );
  }

  private async _ensureCodexCliInstalled(): Promise<boolean> {
    if (findCodexPath()) return true;
    const choice = await vscode.window.showInformationMessage(
      'ChatGPT subscription mode requires Codex CLI. Install it now?',
      {modal: true},
      'Install Codex CLI',
    );
    if (choice !== 'Install Codex CLI') {
      await this._refreshBackendState();
      return false;
    }
    const installed = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'KISS Sorcar: Installing Codex CLI',
        cancellable: false,
      },
      async () => await installCodexCli(),
    );
    await this._refreshBackendState();
    if (installed) return true;
    vscode.window.showErrorMessage(
      'KISS Sorcar: Failed to install Codex CLI automatically. Install it manually with "npm install -g @openai/codex".',
    );
    return false;
  }

  private async _setActiveBackend(
    backend: BackendId,
    tabId = this._activeTabId,
  ): Promise<void> {
    if (this._runningTabs.size > 0) {
      this._sendToWebview({
        type: 'error',
        text: 'Stop running tasks before switching authentication.',
        tabId,
      });
      return;
    }
    this._activeBackend = backend;
    await this._stateStore.update('kissSorcar.activeBackend', backend);
    await this._refreshBackendState(tabId);
    this._sendToWebview({type: 'clearChat', tabId});
    await this._requestModels(tabId);
    this._getServiceProcess().sendCommand({type: 'getInputHistory'});
  }

  private async _requestModels(tabId?: string): Promise<void> {
    if (this._activeBackend === 'codex') {
      const backend = this._getCodexBackend(tabId || this._activeTabId);
      await backend.start(this._getWorkDir());
      await backend.requestModels();
      return;
    }
    this._getServiceProcess().sendCommand({type: 'getModels'});
  }

  /**
   * Called by VS Code when the sidebar view needs to be rendered.
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'media'),
        vscode.Uri.joinPath(this._extensionUri, 'out'),
      ],
    };

    webviewView.webview.html = buildChatHtml(
      webviewView.webview,
      this._extensionUri,
      this._selectedModel,
    );

    webviewView.webview.onDidReceiveMessage((message: FromWebviewMessage) =>
      this._handleMessage(message),
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        const proc = this._getServiceProcess();
        proc.sendCommand({type: 'getInputHistory'});
      }
    });

    webviewView.onDidDispose(() => {
      this._disposed = true;
      this._resolveAllWorktreeActions();
    });

    if (this._onFirstResolve) {
      const cb = this._onFirstResolve;
      this._onFirstResolve = undefined;
      cb();
    }
  }

  /** Whether the underlying webview is currently visible. */
  get visible(): boolean {
    return this._view?.visible ?? false;
  }

  /** Whether the webview currently has input focus. */
  get hasFocus(): boolean {
    return this._webviewHasFocus;
  }

  /**
   * Snapshot the file paths of all currently open editor tabs.
   *
   * Used before the merge UI opens so we can later close any
   * tabs that were only opened for the merge review.
   */
  private _getOpenEditorFiles(): Set<string> {
    const files = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          files.add(tab.input.uri.fsPath);
        }
      }
    }
    return files;
  }

  /**
   * Close editor tabs that were not open before the merge started.
   *
   * Reads the snapshot from ``_preMergeOpenFiles``, compares it
   * against the currently open tabs, closes extras, and clears
   * the snapshot.
   */
  private async _restorePreMergeEditors(tabId: string): Promise<void> {
    const snapshot = this._preMergeOpenFiles.get(tabId);
    this._preMergeOpenFiles.delete(tabId);
    if (!snapshot) return;
    const tabsToClose: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          if (!snapshot.has(tab.input.uri.fsPath)) {
            tabsToClose.push(tab);
          }
        }
      }
    }
    if (tabsToClose.length > 0) {
      await vscode.window.tabGroups.close(tabsToClose);
    }
  }

  private _getWorkDir(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return process.cwd();
  }

  private _sendToWebview(message: ToWebviewMessage): void {
    if (!this._disposed && this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private _sendWelcomeSuggestions(): void {
    const jsonPath = path.join(this._extensionUri.fsPath, 'SAMPLE_TASKS.json');
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      this._sendToWebview({
        type: 'welcome_suggestions',
        suggestions: data,
      } as ToWebviewMessage);
    } catch {
      this._sendToWebview({
        type: 'welcome_suggestions',
        suggestions: [],
      } as ToWebviewMessage);
    }
  }

  /**
   * Read ``~/.kiss/remote-url.json`` and post the tunnel/local URL to
   * the webview.  Retries on failure and falls back to polling with
   * ``fs.watchFile`` so the URL appears even when the daemon starts
   * after the sidebar.
   */
  private _sendRemoteUrl(retries: number = 6): void {
    const urlFile = path.join(os.homedir(), '.kiss', 'remote-url.json');
    if (this._tryReadAndSendUrl(urlFile)) return;
    // Retry after a delay — the daemon may still be starting the tunnel
    if (retries > 0) {
      setTimeout(() => this._sendRemoteUrl(retries - 1), 10_000);
    } else {
      // All retries exhausted — poll the file for up to 5 minutes
      this._watchUrlFile(urlFile);
    }
  }

  /**
   * Try to read the URL file and post to the webview.
   * Returns true if the URL was sent successfully.
   */
  private _tryReadAndSendUrl(urlFile: string): boolean {
    try {
      const data = JSON.parse(fs.readFileSync(urlFile, 'utf-8'));
      const url = data.tunnel || data.local || '';
      if (url) {
        this._sendToWebview({
          type: 'remote_url',
          url,
        } as ToWebviewMessage);
        return true;
      }
    } catch {
      /* file missing or malformed */
    }
    return false;
  }

  private _urlFileWatchTimer?: ReturnType<typeof setInterval>;

  /**
   * Poll ``~/.kiss/remote-url.json`` every 10 seconds for up to 5
   * minutes.  Stops as soon as the URL is successfully sent.
   */
  private _watchUrlFile(urlFile: string): void {
    if (this._urlFileWatchTimer) return;
    let remaining = 30; // 30 × 10s = 5 minutes
    this._urlFileWatchTimer = setInterval(() => {
      remaining--;
      if (this._tryReadAndSendUrl(urlFile) || remaining <= 0) {
        clearInterval(this._urlFileWatchTimer!);
        this._urlFileWatchTimer = undefined;
      }
    }, 10_000);
  }

  private _getVisibleEditorFile(): string {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      return activeEditor.document.uri.fsPath;
    }
    for (const group of vscode.window.tabGroups.all) {
      const activeTab = group.activeTab;
      if (activeTab && activeTab.input instanceof vscode.TabInputText) {
        return activeTab.input.uri.fsPath;
      }
    }
    return '';
  }

  private async _openWorktreeInScm(worktreeDir: string): Promise<void> {
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (!gitExt) return;
      const git = gitExt.isActive ? gitExt.exports : await gitExt.activate();
      const api = git.getAPI(1);
      if (api.openRepository) {
        await api.openRepository(vscode.Uri.file(worktreeDir));
      }
    } catch (err) {
      console.error('[kissSorcar] Failed to open worktree in SCM:', err);
    }
  }

  private async _closeWorktreeInScm(worktreeDir: string): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        'git.close',
        vscode.Uri.file(worktreeDir),
      );
    } catch {
      /* ignored */
    }
  }

  private _startTask(
    prompt: string,
    model: string,
    activeFile?: string,
    attachments?: Attachment[],
    useWorktree?: boolean,
    useParallel?: boolean,
    tabId?: string,
    workDir?: string,
    skipMerge?: boolean,
    reuseProcess?: boolean,
    thinkingEffort?: CodexReasoningEffort,
  ): void {
    const effectiveWorkDir = workDir || this._getWorkDir();
    const effectiveTabId = tabId || this._activeTabId || '__default__';
    if (this._activeBackend === 'codex') {
      void this._startCodexTask(
        prompt,
        model,
        effectiveWorkDir,
        activeFile,
        attachments,
        useWorktree,
        useParallel,
        effectiveTabId,
        skipMerge,
        thinkingEffort,
        this._codexServiceTier,
      );
      return;
    }

    // Reuse existing process for queued tasks to preserve deferred_snapshot
    let proc: AgentProcess;
    if (reuseProcess) {
      const existing = this._taskProcesses.get(effectiveTabId);
      if (existing && existing.isAlive) {
        proc = existing;
      } else {
        proc = this._createTaskProcess(effectiveTabId);
      }
    } else {
      proc = this._createTaskProcess(effectiveTabId);
    }

    const started = proc.start(effectiveWorkDir);
    if (!started) {
      if (tabId !== undefined) this._runningTabs.delete(tabId);
      this._sendToWebview({type: 'status', running: false, tabId});
      return;
    }
    this._sendToWebview({type: 'setTaskText', text: prompt, tabId});
    this._sendToWebview({type: 'status', running: true, tabId});
    proc.sendCommand({
      type: 'run',
      prompt,
      model,
      workDir: effectiveWorkDir,
      activeFile,
      attachments,
      useWorktree,
      useParallel,
      tabId,
      skipMerge,
    });
  }

  private async _startCodexTask(
    prompt: string,
    model: string,
    workDir: string,
    activeFile?: string,
    attachments?: Attachment[],
    useWorktree?: boolean,
    useParallel?: boolean,
    tabId?: string,
    skipMerge?: boolean,
    thinkingEffort?: CodexReasoningEffort,
    codexServiceTier?: CodexServiceTier,
  ): Promise<void> {
    const effectiveTabId = tabId || this._activeTabId || '__default__';
    if (!(await this._ensureCodexCliInstalled())) {
      this._runningTabs.delete(effectiveTabId);
      this._sendToWebview({
        type: 'status',
        running: false,
        tabId: effectiveTabId,
      });
      return;
    }
    const backend = this._getCodexBackend(effectiveTabId);
    this._sendToWebview({
      type: 'setTaskText',
      text: prompt,
      tabId: effectiveTabId,
    });
    try {
      await backend.submitTask({
        prompt,
        model,
        workDir,
        activeFile,
        activeFileContent: vscode.window.activeTextEditor?.document.getText(),
        attachments,
        useWorktree,
        useParallel,
        skipMerge,
        thinkingEffort,
        codexServiceTier,
      });
    } catch (error) {
      this._runningTabs.delete(effectiveTabId);
      this._sendToWebview({
        type: 'error',
        text: error instanceof Error ? error.message : String(error),
        tabId: effectiveTabId,
      });
      this._sendToWebview({
        type: 'status',
        running: false,
        tabId: effectiveTabId,
      });
    }
  }

  private async _handleMessage(message: FromWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        const readyTabId = message.tabId;
        if (readyTabId) this._activeTabId = readyTabId;
        await this._refreshBackendState(readyTabId || '__default__');
        if (this._activeBackend === 'codex') {
          await this._requestModels(readyTabId);
        } else {
          this._getServiceProcess().sendCommand({type: 'getModels'});
        }
        this._sendWelcomeSuggestions();
        this._sendRemoteUrl();
        this._getServiceProcess().sendCommand({type: 'getInputHistory'});
        this._sendToWebview({type: 'focusInput'} as ToWebviewMessage);
        // Auto-reload events for restored tabs that had active sessions
        const restoredTabs = message.restoredTabs;
        if (restoredTabs && restoredTabs.length > 0) {
          const svc = this._getServiceProcess();
          for (const rt of restoredTabs) {
            if (this._activeBackend === 'codex') {
              await this._getCodexBackend(rt.tabId).resumeSession(rt.chatId);
            } else {
              svc.sendCommand({
                type: 'resumeSession',
                chatId: rt.chatId,
                tabId: rt.tabId,
              });
            }
          }
        }
        break;
      }

      case 'submit': {
        const tabId = message.tabId;
        if (tabId) this._activeTabId = tabId;
        this._rememberThinkingEffort(message.thinkingEffort);
        this._rememberCodexServiceTier(message.codexServiceTier);
        if (tabId !== undefined && this._runningTabs.has(tabId)) return;

        const tabWorkDir = message.workDir;
        const effectiveWorkDir = tabWorkDir || this._getWorkDir();

        const trimmed = message.prompt.trim();
        if (trimmed && !trimmed.includes('\n')) {
          const bare = trimmed.replace(/^PWD[/\\]/, '');
          const resolved = path.resolve(effectiveWorkDir, bare);
          if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            const uri = vscode.Uri.file(resolved);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
              preview: false,
              viewColumn: vscode.ViewColumn.One,
            });
            return;
          }
        }

        if (tabId !== undefined) this._runningTabs.add(tabId);
        this._startTask(
          message.prompt,
          message.model,
          this._getVisibleEditorFile() || undefined,
          message.attachments,
          message.useWorktree,
          message.useParallel,
          tabId,
          effectiveWorkDir,
          message.skipMerge,
          message.reuseProcess,
          message.thinkingEffort || this._thinkingEffort,
        );
        break;
      }

      case 'stop': {
        const stopTabId = message.tabId;
        if (this._activeBackend === 'codex') {
          this._getCodexBackend(stopTabId || this._activeTabId).stopTask();
          break;
        }
        if (stopTabId !== undefined) {
          const stopProc = this._taskProcesses.get(stopTabId);
          if (stopProc) stopProc.sendCommand({type: 'stop', tabId: stopTabId});
        } else {
          // Stop all running task processes
          for (const proc of this._taskProcesses.values()) proc.stop();
        }
        break;
      }

      case 'selectModel': {
        this._selectedModel = message.model;
        const selTabId = message.tabId;
        if (this._activeBackend === 'codex') {
          await this._getCodexBackend(
            selTabId || this._activeTabId,
          ).selectModel(message.model);
          break;
        }
        // Persist model selection via service process
        this._getServiceProcess().sendCommand({
          type: 'selectModel',
          model: message.model,
          tabId: selTabId,
        });
        break;
      }

      case 'getModels':
        await this._requestModels(this._activeTabId);
        break;

      case 'getInputHistory':
        this._getServiceProcess().sendCommand({
          type: message.type,
        } as AgentCommand);
        break;

      case 'getBackendState':
        await this._refreshBackendState(this._activeTabId || '__default__');
        break;

      case 'switchBackend':
        if (
          message.backend === 'codex' &&
          !(await this._ensureCodexCliInstalled())
        ) {
          break;
        }
        await this._setActiveBackend(message.backend, this._activeTabId);
        break;

      case 'signInCodex': {
        if (!(await this._ensureCodexCliInstalled())) break;
        await this._setActiveBackend('codex', this._activeTabId);
        const authUrl = await this._getCodexBackend(
          this._activeTabId || '__default__',
        ).signInWithChatGpt();
        if (authUrl) {
          await vscode.env.openExternal(vscode.Uri.parse(authUrl));
        }
        break;
      }

      case 'signOutCodex':
        await this._getCodexBackend(
          this._activeTabId || '__default__',
        ).signOut();
        await this._refreshBackendState(this._activeTabId || '__default__');
        await this._requestModels(this._activeTabId);
        break;

      case 'newChat': {
        const newChatTabId = message.tabId;
        if (this._activeBackend === 'codex') {
          await this._getCodexBackend(
            newChatTabId || this._activeTabId || '__default__',
          ).newChat();
          break;
        }
        const newChatProc = newChatTabId
          ? this._getTabProcess(newChatTabId)
          : this._getServiceProcess();
        newChatProc.sendCommand({type: 'newChat', tabId: newChatTabId});
        break;
      }

      case 'getHistory':
        this._getServiceProcess().sendCommand({
          type: 'getHistory',
          query: message.query,
          offset: message.offset,
          generation: message.generation,
        });
        break;

      case 'getFiles':
        this._getServiceProcess().sendCommand({
          type: 'getFiles',
          prefix: message.prefix,
        });
        break;

      case 'userAnswer': {
        const ansTabId = message.tabId;
        if (this._activeBackend === 'codex') {
          this._getCodexBackend(ansTabId || this._activeTabId).answerUserInput(
            message.answer,
          );
          break;
        }
        const ansProc = ansTabId
          ? this._taskProcesses.get(ansTabId)
          : undefined;
        if (ansProc)
          ansProc.sendCommand({
            type: 'userAnswer',
            answer: message.answer,
            tabId: ansTabId,
          });
        break;
      }

      case 'userActionDone': {
        const doneTabId = this._activeTabId;
        const doneProc = doneTabId
          ? this._taskProcesses.get(doneTabId)
          : undefined;
        if (doneProc) {
          doneProc.sendCommand({
            type: 'userAnswer',
            answer: 'done',
            tabId: doneTabId,
          });
        }
        break;
      }

      case 'recordFileUsage':
        if (message.path) {
          this._getServiceProcess().sendCommand({
            type: 'recordFileUsage',
            path: message.path,
          });
        }
        break;

      case 'openFile':
        if (message.path) {
          const filePath = path.resolve(this._getWorkDir(), message.path);
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, {
              preview: false,
              viewColumn: vscode.ViewColumn.One,
            });
            if (message.line !== undefined && message.line > 0) {
              const pos = new vscode.Position(message.line - 1, 0);
              editor.selection = new vscode.Selection(pos, pos);
              editor.revealRange(
                new vscode.Range(pos, pos),
                vscode.TextEditorRevealType.InCenter,
              );
            }
          }
        }
        break;

      case 'resumeSession': {
        const resumeTabId = message.tabId;
        if (this._activeBackend === 'codex') {
          await this._getCodexBackend(
            resumeTabId || this._activeTabId || '__default__',
          ).resumeSession(String(message.id));
          break;
        }
        const resumeProc = resumeTabId
          ? this._getTabProcess(resumeTabId)
          : this._getServiceProcess();
        resumeProc.sendCommand({
          type: 'resumeSession',
          chatId: message.id,
          tabId: resumeTabId,
        });
        break;
      }

      case 'getAdjacentTask': {
        const adjTabId = message.tabId;
        const adjProc = adjTabId
          ? this._getTabProcess(adjTabId)
          : this._getServiceProcess();
        adjProc.sendCommand({
          type: 'getAdjacentTask',
          tabId: adjTabId,
          task: message.task,
          direction: message.direction,
        });
        break;
      }

      case 'getWelcomeSuggestions':
        this._sendWelcomeSuggestions();
        this._sendRemoteUrl();
        break;

      case 'complete': {
        const editorFile = this._getVisibleEditorFile();
        const completeDoc = editorFile
          ? vscode.workspace.textDocuments.find(
              d => d.uri.fsPath === editorFile,
            )
          : undefined;
        this._getServiceProcess().sendCommand({
          type: 'complete',
          query: message.query,
          activeFile: editorFile || undefined,
          activeFileContent: completeDoc?.getText(),
        });
        break;
      }

      case 'mergeAction': {
        const mTabId = message.tabId || this._activeTabId;
        const mgr = this._mergeManagers.get(mTabId);
        if (!mgr) {
          if (message.action === 'all-done') {
            if (this._activeBackend === 'codex') {
              await this._getCodexBackend(mTabId).finishMerge(mTabId);
            } else {
              this.sendMergeAllDone(mTabId);
            }
          }
          break;
        }
        const mergeDispatch: Record<string, () => void> = {
          accept: () => mgr.acceptChange(),
          reject: () => mgr.rejectChange(),
          prev: () => mgr.prevChange(),
          next: () => mgr.nextChange(),
          'accept-all': () => mgr.acceptAll(),
          'reject-all': () => mgr.rejectAll(),
          'accept-file': () => mgr.acceptFile(),
          'reject-file': () => mgr.rejectFile(),
        };
        const mAction = message.action;
        const handler = mergeDispatch[mAction];
        if (handler) handler();
        else if (mAction === 'all-done') {
          if (this._activeBackend === 'codex') {
            await this._getCodexBackend(mTabId).finishMerge(mTabId);
          } else {
            this.sendMergeAllDone(mTabId);
          }
        }
        break;
      }

      case 'generateCommitMessage':
        void this.generateCommitMessage();
        break;

      case 'worktreeAction': {
        const wtAction = message.action;
        const wtTabId = message.tabId;
        const progressTitle =
          wtAction === 'merge'
            ? 'Committing and merging worktree…'
            : wtAction === 'discard'
              ? 'Discarding worktree…'
              : 'Processing worktree action…';
        this._showActionProgress(
          progressTitle,
          wtTabId,
          this._worktreeProgresses,
          this._worktreeActionResolves,
        );
        if (this._activeBackend === 'codex') {
          await this._getCodexBackend(
            wtTabId || this._activeTabId || '__default__',
          ).worktreeAction(
            wtAction as 'merge' | 'discard',
            wtTabId || this._activeTabId || '__default__',
          );
          break;
        }
        const wtProc = wtTabId
          ? this._getTabProcess(wtTabId)
          : this._getServiceProcess();
        wtProc.sendCommand({
          type: 'worktreeAction',
          action: wtAction,
          tabId: wtTabId,
        });
        break;
      }

      case 'autocommitAction': {
        const acAction = message.action;
        const acTabId = message.tabId;
        if (this._activeBackend === 'codex') {
          await this._getCodexBackend(
            acTabId || this._activeTabId || '__default__',
          ).autocommitAction(acAction, acTabId || this._activeTabId);
          break;
        }
        if (acAction === 'commit') {
          this._showActionProgress(
            'Auto-committing…',
            acTabId,
            this._autocommitProgresses,
            this._autocommitActionResolves,
          );
        }
        const acProc = acTabId
          ? this._getTabProcess(acTabId)
          : this._getServiceProcess();
        acProc.sendCommand({
          type: 'autocommitAction',
          action: acAction,
          tabId: acTabId,
        });
        break;
      }

      case 'setSkipMerge': {
        const smTabId = message.tabId;
        const smProc = smTabId
          ? this._getTabProcess(smTabId)
          : this._getServiceProcess();
        smProc.sendCommand({
          type: 'setSkipMerge',
          tabId: smTabId,
          skip: message.skip,
        });
        break;
      }

      case 'getConfig':
        this._getServiceProcess().sendCommand({type: 'getConfig'});
        break;

      case 'saveConfig':
        this._rememberThinkingEffort(message.config?.thinking_effort);
        this._rememberCodexServiceTier(message.config?.codex_service_tier);
        this._getServiceProcess().sendCommand({
          type: 'saveConfig',
          config: message.config,
          apiKeys: message.apiKeys,
        });
        break;

      case 'resolveDroppedPaths': {
        const workDir = this._getWorkDir();
        const paths = (message.uris || [])
          .map((uri: string) => {
            try {
              const absPath = vscode.Uri.parse(uri).fsPath;
              return path.relative(workDir, absPath);
            } catch {
              return '';
            }
          })
          .filter((p: string) => p && !p.startsWith('..'));
        this._sendToWebview({type: 'droppedPaths', paths} as ToWebviewMessage);
        break;
      }

      case 'webviewFocusChanged':
        this._webviewHasFocus = message.focused;
        break;

      case 'focusEditor':
        vscode.commands.executeCommand(
          'workbench.action.focusFirstEditorGroup',
        );
        break;

      case 'closeTab': {
        const closeTabId = message.tabId;
        if (closeTabId) {
          const closeBackend = this._codexBackends.get(closeTabId);
          if (closeBackend) {
            closeBackend.closeTab(closeTabId);
            this._codexBackends.delete(closeTabId);
            this._runningTabs.delete(closeTabId);
            break;
          }
          const closeProc = this._taskProcesses.get(closeTabId);
          if (closeProc) {
            closeProc.sendCommand({type: 'closeTab', tabId: closeTabId});
          } else {
            this._getServiceProcess().sendCommand({
              type: 'closeTab',
              tabId: closeTabId,
            });
          }
        }
        break;
      }
    }
  }

  /**
   * Dispatch a merge command to the active tab's MergeManager.
   *
   * Used by extension.ts keyboard shortcuts that don't know the tab ID.
   * Routes to the MergeManager of ``_activeTabId``.
   */
  public handleMergeCommand(
    cmd:
      | 'acceptChange'
      | 'rejectChange'
      | 'prevChange'
      | 'nextChange'
      | 'acceptAll'
      | 'rejectAll'
      | 'acceptFile'
      | 'rejectFile',
  ): void {
    const mgr = this._mergeManagers.get(this._activeTabId);
    if (mgr) void mgr[cmd]();
  }

  /** Notify the agent that all merge changes have been reviewed. */
  public sendMergeAllDone(tabId?: string): void {
    const proc = tabId ? this._taskProcesses.get(tabId) : undefined;
    (proc || this._getServiceProcess()).sendCommand({
      type: 'mergeAction',
      action: 'all-done',
      tabId,
    });
  }

  /** Submit a task programmatically (e.g. from runSelection command). */
  public submitTask(prompt: string): void {
    if (!prompt.trim()) return;
    void this._startTask(
      prompt.trim(),
      this._selectedModel,
      this._getVisibleEditorFile() || undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this._thinkingEffort,
    );
  }

  /** Stop the currently running task in the active tab. */
  public stopTask(): void {
    this._sendToWebview({type: 'triggerStop'} as ToWebviewMessage);
  }

  /** Focus the chat input in the sidebar. */
  public async focusChatInput(): Promise<void> {
    if (!this._view) {
      // Webview not yet resolved — trigger resolution by focusing the view
      await vscode.commands.executeCommand(
        'kissSorcar.chatViewSecondary.focus',
      );
      await new Promise(r => setTimeout(r, 200));
    }
    if (this._view) {
      this._view.show(true);
      await new Promise(r => setTimeout(r, 150));
      this._sendToWebview({type: 'focusInput'});
    }
  }

  /** Append text to the chat input and focus it. */
  public async appendToInput(text: string): Promise<void> {
    if (this._view) {
      this._view.show(true);
      await new Promise(r => setTimeout(r, 150));
      this._sendToWebview({type: 'appendToInput', text});
    }
  }

  /** Start a new conversation in a new tab (without affecting running tabs). */
  public newConversation(): void {
    this._sendToWebview({type: 'clearChat'});
  }

  /** Ensure at least one chat tab exists; creates one only if there are none. */
  public ensureChat(): void {
    this._sendToWebview({type: 'ensureChat'});
  }

  /**
   * Generate a commit message using this view's agent process.
   *
   * @param token Optional cancellation token.
   * @param tabId Optional tab ID — each tab can independently request a
   *              commit message without blocking other tabs.
   */
  public generateCommitMessage(
    token?: vscode.CancellationToken,
    tabId: string = '',
  ): Promise<void> {
    if (this._commitPendingTabs.has(tabId)) return Promise.resolve();
    this._commitPendingTabs.add(tabId);
    if (this._activeBackend === 'codex') {
      const backend = this._getCodexBackend(
        tabId || this._activeTabId || '__default__',
      );
      return backend
        .generateCommitMessage(this._getWorkDir())
        .then(result => {
          this._onCommitMessage.fire(result);
        })
        .finally(() => {
          this._commitPendingTabs.delete(tabId);
        });
    }
    const proc = this._getServiceProcess();
    proc.start(this._getWorkDir());
    proc.sendCommand({
      type: 'generateCommitMessage',
      model: this._selectedModel,
    });

    return new Promise<void>(resolve => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        this._commitPendingTabs.delete(tabId);
        disposable.dispose();
        clearTimeout(timer);
        resolve();
      };
      const disposable = this._onCommitMessage.event(() => done());
      token?.onCancellationRequested(() => done());
      const timer = setTimeout(done, 30_000);
    });
  }

  /** Cleanup: kill all agent processes and dispose listeners. */
  public dispose(): void {
    this._disposed = true;
    if (this._urlFileWatchTimer) {
      clearInterval(this._urlFileWatchTimer);
      this._urlFileWatchTimer = undefined;
    }
    this._resolveAllWorktreeActions();
    for (const mgr of this._mergeManagers.values()) mgr.dispose();
    this._mergeManagers.clear();
    for (const proc of this._taskProcesses.values()) proc.dispose();
    this._taskProcesses.clear();
    if (this._serviceProcess) {
      this._serviceProcess.dispose();
      this._serviceProcess = null;
    }
    for (const backend of this._codexBackends.values()) backend.dispose();
    this._codexBackends.clear();
    this._onCommitMessage.dispose();
  }
}
