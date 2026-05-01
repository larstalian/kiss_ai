import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {EventEmitter} from 'events';
import {
  ChatBackend,
  emitBackendMessage,
  HistoryQuery,
  SubmitTaskParams,
} from './Backends';
import {CodexAppServerClient} from './CodexAppServerClient';
import {findCodexPath} from './CodexBinary';
import type {KissSessionStore, PreparedCodexTask} from './KissSessionStore';
import {
  BackendId,
  BackendState,
  CodexRateLimitInfo,
  CodexReasoningEffort,
  CodexServiceTier,
  ToWebviewMessage,
} from './types';

interface StorageLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

type CodexAccount =
  | {type: 'apiKey'}
  | {type: 'chatgpt'; email: string; planType: string};

const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>([
  'low',
  'medium',
  'high',
  'xhigh',
]);

function normalizeCodexReasoningEffort(effort: unknown): CodexReasoningEffort {
  return typeof effort === 'string' &&
    CODEX_REASONING_EFFORTS.has(effort as CodexReasoningEffort)
    ? (effort as CodexReasoningEffort)
    : 'medium';
}

function normalizeCodexServiceTier(tier: unknown): CodexServiceTier {
  if (tier === 'fast') return 'fast';
  return 'standard';
}

function codexServiceTierForRequest(
  tier: unknown,
): {serviceTier: 'fast'} | Record<string, never> {
  return normalizeCodexServiceTier(tier) === 'fast'
    ? {serviceTier: 'fast'}
    : {};
}

type CodexModel = {
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
};

type CodexThreadItem =
  | {
      type: 'userMessage';
      id: string;
      content: Array<{type: string; text?: string}>;
    }
  | {type: 'agentMessage'; id: string; text: string; phase: string | null}
  | {type: 'reasoning'; id: string; summary: string[]; content: string[]}
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      status: string;
      aggregatedOutput: string | null;
    }
  | {
      type: 'fileChange';
      id: string;
      status: string;
      changes: Array<{path: string; diff: string; kind: string}>;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: string;
      arguments: unknown;
      result: unknown;
      error: {message?: string | null} | null;
    }
  | {
      type: 'dynamicToolCall';
      id: string;
      tool: string;
      status: string;
      arguments: unknown;
      contentItems: Array<{type?: string; text?: string}> | null;
      success: boolean | null;
    };

type RateLimitsResponse = {
  rateLimits: {
    limitId: string;
    planType?: string | null;
    primary?: {usedPercent?: number | null; resetsAt?: number | null} | null;
    secondary?: {usedPercent?: number | null; resetsAt?: number | null} | null;
  };
};

type PendingUserInput = {
  requestId: number;
  questionIds: string[];
};

const STORE_KEYS = {
  activeBackend: 'kissSorcar.activeBackend',
} as const;

const PERSISTED_EVENT_TYPES = new Set<ToWebviewMessage['type']>([
  'thinking_start',
  'thinking_delta',
  'thinking_end',
  'text_delta',
  'text_end',
  'tool_call',
  'tool_result',
  'system_output',
  'result',
  'system_prompt',
  'prompt',
  'usage_info',
  'followup_suggestion',
]);

const SESSION_RESPONSE_TYPES = new Set<ToWebviewMessage['type']>([
  'codexTaskPrepared',
  'codexTaskPersisted',
  'modelUsage',
  'models',
  'history',
  'files',
  'task_events',
  'inputHistory',
]);

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pricingLabelForModel(model: CodexModel): string {
  return model.isDefault ? 'Included' : 'ChatGPT plan';
}

function clipResultSummary(text: string): string {
  const normalized = text.trim();
  if (!normalized) return 'No summary available';
  return normalized.length <= 2_000
    ? normalized
    : `${normalized.slice(0, 1_997)}...`;
}

export class CodexBackend implements ChatBackend {
  readonly id: BackendId = 'codex';
  readonly events = new EventEmitter();

  private readonly client: CodexAppServerClient;
  private readonly store: StorageLike;
  private readonly sessionStore: KissSessionStore;
  private readonly ownsSessionStore: boolean;
  private readonly isCliAvailable: () => boolean;
  private workDir = '';
  private running = false;
  private started = false;
  private currentThreadId: string | null = null;
  private currentTurnId: string | null = null;
  private currentTaskId: number | null = null;
  private currentTask: string | null = null;
  private pendingSignInId: string | null = null;
  private pendingUserInput: PendingUserInput | null = null;
  private currentFinalText = '';
  private currentTokenUsage: {
    totalTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  } | null = null;
  private currentReplayEvents: ToWebviewMessage[] = [];
  private itemPhases = new Map<string, string | null>();
  private cleanupDirs = new Set<string>();
  private backendState: BackendState;
  private selectedModel = 'gpt-5.4';
  private codexModels: CodexModel[] = [];

  constructor(
    store: StorageLike,
    client?: CodexAppServerClient,
    isCliAvailable: () => boolean = () => !!findCodexPath(),
    sessionStore?: KissSessionStore,
    ownsSessionStore = sessionStore === undefined,
  ) {
    this.store = store;
    this.client = client ?? new CodexAppServerClient();
    this.isCliAvailable = isCliAvailable;
    if (sessionStore) {
      this.sessionStore = sessionStore;
      this.ownsSessionStore = ownsSessionStore;
    } else {
      const {AgentProcess} =
        require('./AgentProcess') as typeof import('./AgentProcess');
      const {AgentProcessKissSessionStore} =
        require('./KissSessionStore') as typeof import('./KissSessionStore');
      this.sessionStore = new AgentProcessKissSessionStore(new AgentProcess());
      this.ownsSessionStore = true;
    }
    this.backendState = {
      activeBackend: this.store.get(STORE_KEYS.activeBackend, 'apiKey'),
      apiKeysAvailable: false,
      codexAvailable: this.isCliAvailable(),
      codexAuthenticated: false,
      codexAuthMode: null,
      codexSignInPending: false,
      codexRateLimit: null,
      codexError: null,
    };

    this.client.on('notification', notification => {
      void this.handleNotification(
        notification as {method: string; params?: unknown},
      );
    });
    this.client.on('serverRequest', request => {
      void this.handleServerRequest(
        request as {id: number; method: string; params?: unknown},
      );
    });
    this.client.on('exit', error => {
      this.running = false;
      this.started = false;
      this.currentThreadId = null;
      this.currentTurnId = null;
      this.backendState.codexError = normalizeError(error);
      this.backendState.codexAuthenticated = false;
      this.backendState.codexSignInPending = false;
      this.emitBackendState();
      this.emitMessage({type: 'status', running: false});
    });
    this.client.on('log', entry => {
      const payload = entry as {
        level?: string;
        fields?: Record<string, unknown>;
        text?: string;
      };
      const message = String(
        payload.fields?.message ?? payload.text ?? '',
      ).trim();
      if (!message) return;
      if (payload.level === 'ERROR') {
        this.backendState.codexError = message;
        this.emitBackendState();
      }
    });
    this.sessionStore.events?.on('message', message => {
      this.handleSessionMessage(message as ToWebviewMessage);
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  hasCliAvailable(): boolean {
    return this.isCliAvailable();
  }

  isAuthenticated(): boolean {
    return this.backendState.codexAuthenticated;
  }

  async start(workDir: string): Promise<boolean> {
    this.workDir = workDir;
    if (!this.ensureSessionStore(workDir)) {
      return false;
    }
    try {
      await this.client.start(workDir);
      this.started = true;
      this.backendState.codexAvailable = true;
      this.backendState.codexError = null;
      await this.refreshAccountState();
      const usage = await this.safeGetModelUsage();
      if (usage.lastModel) {
        this.selectedModel = usage.lastModel;
      }
      return true;
    } catch (error) {
      this.started = false;
      this.backendState.codexAvailable = false;
      this.backendState.codexAuthenticated = false;
      this.backendState.codexError = normalizeError(error);
      this.emitBackendState();
      this.emitMessage({type: 'error', text: this.backendState.codexError});
      return false;
    }
  }

  dispose(): void {
    this.client.dispose();
    if (this.ownsSessionStore) {
      this.sessionStore.dispose();
    }
  }

  closeTab(tabId: string): void {
    this.sessionStore.closeTab?.(tabId);
    this.dispose();
  }

  async submitTask(params: SubmitTaskParams): Promise<void> {
    if (!(await this.start(params.workDir))) {
      this.emitMessage({type: 'status', running: false});
      return;
    }
    if (!this.backendState.codexAuthenticated) {
      this.emitMessage({
        type: 'error',
        text: 'Sign in with ChatGPT before using the Codex backend.',
      });
      this.emitMessage({type: 'status', running: false});
      return;
    }
    if (params.attachments?.some(att => !att.mimeType.startsWith('image/'))) {
      this.emitMessage({
        type: 'error',
        text: 'Codex currently supports image attachments only in this backend.',
      });
      this.emitMessage({type: 'status', running: false});
      return;
    }

    this.selectedModel = params.model;

    let prepared: PreparedCodexTask;
    try {
      prepared = await this.sessionStore.prepareCodexTask(
        params.prompt,
        params.workDir,
        {
          useWorktree: !!params.useWorktree,
          useParallel: !!params.useParallel,
          skipMerge: !!params.skipMerge,
        },
      );
    } catch (error) {
      this.emitMessage({
        type: 'error',
        text: `Failed to prepare Codex task: ${normalizeError(error)}`,
      });
      this.emitMessage({type: 'status', running: false});
      return;
    }
    const effectiveWorkDir = prepared.workDir || params.workDir;
    const input = await this.buildUserInput(
      prepared.prompt,
      params.attachments ?? [],
    );

    this.running = true;
    this.currentThreadId = null;
    this.currentTurnId = null;
    this.currentTaskId = prepared.taskId;
    this.currentTask = prepared.task;
    this.currentFinalText = '';
    this.currentTokenUsage = null;
    this.currentReplayEvents = [];
    this.itemPhases.clear();

    this.emitMessage({type: 'status', running: true});
    this.emitMessage({type: 'clear', chat_id: prepared.chatId || undefined});
    this.emitTaskEvent({type: 'prompt', text: prepared.prompt});
    const serviceTierParams = codexServiceTierForRequest(
      params.codexServiceTier,
    );

    try {
      const thread = await this.client.request<{thread: {id: string}}>(
        'thread/start',
        {
          cwd: effectiveWorkDir,
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          model: params.model,
          ...serviceTierParams,
          personality: 'pragmatic',
          ephemeral: true,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      );
      this.currentThreadId = thread.thread.id;
      const response = await this.client.request<{turn: {id: string}}>(
        'turn/start',
        {
          threadId: this.currentThreadId,
          input,
          cwd: effectiveWorkDir,
          approvalPolicy: 'never',
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [effectiveWorkDir],
            readOnlyAccess: {type: 'fullAccess'},
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          model: params.model,
          ...serviceTierParams,
          effort: normalizeCodexReasoningEffort(params.thinkingEffort),
          summary: 'concise',
          personality: 'pragmatic',
        },
      );
      this.currentTurnId = response.turn.id;
      this.selectedModel = params.model;
    } catch (error) {
      await this.finishTurn({
        status: 'failed',
        error: {message: normalizeError(error)},
      });
    }
  }

  stopTask(): void {
    if (!this.currentThreadId || !this.currentTurnId) return;
    void this.client
      .request('turn/interrupt', {
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
      })
      .catch(() => undefined);
  }

  async selectModel(model: string): Promise<void> {
    this.selectedModel = model;
    this.sessionStore.selectModel(model);
  }

  async requestModels(): Promise<void> {
    if (!(await this.start(this.workDir || process.cwd()))) return;
    const usage = await this.safeGetModelUsage();
    if (!this.backendState.codexAuthenticated) {
      if (usage.lastModel) {
        this.selectedModel = usage.lastModel;
      }
      this.emitMessage({
        type: 'models',
        models: [],
        selected: this.selectedModel,
      });
      return;
    }
    const response = await this.client.request<{data: CodexModel[]}>(
      'model/list',
      {},
    );
    this.codexModels = response.data.filter(model => !model.hidden);
    const nextSelected = this.pickSelectedModel(usage.lastModel);
    this.selectedModel = nextSelected;
    this.emitMessage({
      type: 'models',
      models: this.codexModels.map(model => ({
        name: model.model,
        displayName: model.displayName,
        description: model.description,
        vendor: 'Codex',
        inp: 0,
        out: 0,
        uses: usage.usage[model.model] ?? 0,
        pricingText: pricingLabelForModel(model),
      })),
      selected: nextSelected,
    });
  }

  async requestHistory(query: HistoryQuery): Promise<void> {
    if (!this.ensureSessionStore(this.workDir || process.cwd())) {
      this.emitMessage({
        type: 'history',
        sessions: [],
        offset: query.offset ?? 0,
        generation: query.generation,
      });
      return;
    }
    const history = await this.sessionStore.getHistory(query);
    this.emitMessage({
      type: 'history',
      sessions: history.sessions,
      offset: history.offset ?? query.offset,
      generation: history.generation ?? query.generation,
    });
  }

  async requestLastSession(): Promise<void> {
    if (!this.ensureSessionStore(this.workDir || process.cwd())) return;
    const session = await this.sessionStore.getLastSession();
    if (!session) return;
    this.emitMessage({
      type: 'task_events',
      events: session.events,
      task: session.task,
      chat_id: session.chatId,
    });
  }

  async requestFiles(prefix: string, workDir: string): Promise<void> {
    if (!this.ensureSessionStore(workDir)) {
      this.emitMessage({type: 'files', files: []});
      return;
    }
    const files = await this.sessionStore.getFiles(prefix);
    this.emitMessage({type: 'files', files});
  }

  recordFileUsage(filePath: string): void {
    this.sessionStore.recordFileUsage(filePath);
  }

  async resumeSession(id: string): Promise<void> {
    if (!this.ensureSessionStore(this.workDir || process.cwd())) return;
    const session = await this.sessionStore.resumeSession(id);
    if (!session) return;
    this.emitMessage({
      type: 'task_events',
      events: session.events,
      task: session.task,
      chat_id: session.chatId,
    });
  }

  async newChat(): Promise<void> {
    if (!this.ensureSessionStore(this.workDir || process.cwd())) return;
    await this.sessionStore.newChat();
    this.currentThreadId = null;
    this.currentTurnId = null;
    this.currentTaskId = null;
    this.currentTask = null;
    this.currentFinalText = '';
    this.currentReplayEvents = [];
    this.itemPhases.clear();
  }

  async finishMerge(tabId: string): Promise<void> {
    if (!this.ensureSessionStore(this.workDir || process.cwd())) return;
    await this.sessionStore.finishMerge(tabId);
  }

  async worktreeAction(
    action: 'merge' | 'discard',
    tabId: string,
  ): Promise<void> {
    if (!this.ensureSessionStore(this.workDir || process.cwd())) return;
    await this.sessionStore.worktreeAction(action, tabId);
  }

  async autocommitAction(
    action: 'commit' | 'skip',
    tabId: string,
  ): Promise<void> {
    if (!this.ensureSessionStore(this.workDir || process.cwd())) return;
    await this.sessionStore.autocommitAction(action, tabId);
  }

  async requestInputHistory(): Promise<void> {
    if (!this.ensureSessionStore(this.workDir || process.cwd())) {
      this.emitMessage({type: 'inputHistory', tasks: []});
      return;
    }
    this.emitMessage({
      type: 'inputHistory',
      tasks: await this.sessionStore.getInputHistory(),
    });
  }

  async requestGhostSuggestion(query: string): Promise<void> {
    this.emitMessage({type: 'ghost', suggestion: '', query});
  }

  answerUserInput(answer: string): void {
    if (!this.pendingUserInput) return;
    const answers: Record<string, {answers: string[]}> = {};
    const firstId = this.pendingUserInput.questionIds[0];
    if (firstId) {
      answers[firstId] = {answers: [answer]};
    }
    this.client.respond(this.pendingUserInput.requestId, {answers});
    this.pendingUserInput = null;
  }

  async signInWithChatGpt(): Promise<string | null> {
    if (!(await this.start(this.workDir || process.cwd()))) return null;
    const response = await this.client.request<{
      type: string;
      loginId?: string;
      authUrl?: string;
    }>('account/login/start', {
      type: 'chatgpt',
    });
    if (response.type !== 'chatgpt' || !response.loginId || !response.authUrl) {
      return null;
    }
    this.pendingSignInId = response.loginId;
    this.backendState.codexSignInPending = true;
    this.emitBackendState();
    return response.authUrl;
  }

  async signOut(): Promise<void> {
    if (!this.started && !(await this.start(this.workDir || process.cwd())))
      return;
    await this.client.request('account/logout');
    this.pendingSignInId = null;
    await this.refreshAccountState();
    await this.requestModels();
  }

  async generateCommitMessage(
    workDir: string,
  ): Promise<{message: string; error?: string}> {
    const client = new CodexAppServerClient();
    let finalText = '';
    let turnDone = false;
    let turnError: string | null = null;
    const phases = new Map<string, string | null>();

    client.on('notification', notification => {
      const message = notification as {method: string; params?: unknown};
      if (message.method === 'item/started') {
        const params = message.params as {
          item?: {type?: string; id?: string; phase?: string | null};
        };
        if (params.item?.type === 'agentMessage' && params.item.id) {
          phases.set(params.item.id, params.item.phase ?? null);
        }
      }
      if (message.method === 'item/agentMessage/delta') {
        const params = message.params as {itemId?: string; delta?: string};
        if (
          (phases.get(params.itemId || '') ?? 'final_answer') === 'final_answer'
        ) {
          finalText += params.delta || '';
        }
      }
      if (message.method === 'turn/completed') {
        const params = message.params as {
          turn: {error: {message?: string | null} | null};
        };
        turnDone = true;
        turnError = params.turn.error?.message || null;
      }
    });

    try {
      await client.start(workDir);
      const account = await client.request<{account: CodexAccount | null}>(
        'account/read',
        {refreshToken: false},
      );
      if (!account.account) {
        return {
          message: '',
          error:
            'Sign in with ChatGPT before generating commit messages in Codex mode.',
        };
      }

      const thread = await client.request<{thread: {id: string}}>(
        'thread/start',
        {
          cwd: workDir,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          model: this.selectedModel,
          personality: 'pragmatic',
          ephemeral: true,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      );
      await client.request('turn/start', {
        threadId: thread.thread.id,
        input: [
          {
            type: 'text',
            text: 'Inspect the current git diff and return one concise imperative commit message. Return only the commit message.',
            text_elements: [],
          },
        ],
        cwd: workDir,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'readOnly',
          access: {type: 'fullAccess'},
          networkAccess: true,
        },
        model: this.selectedModel,
        effort: 'low',
        summary: 'concise',
        personality: 'pragmatic',
      });

      const deadline = Date.now() + 60_000;
      while (!turnDone && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!turnDone) {
        return {
          message: '',
          error: 'Timed out while generating a commit message with Codex.',
        };
      }
      if (turnError) {
        return {message: '', error: turnError};
      }
      return {message: finalText.trim()};
    } catch (error) {
      return {message: '', error: normalizeError(error)};
    } finally {
      client.dispose();
    }
  }

  setActiveBackend(activeBackend: BackendId, apiKeysAvailable: boolean): void {
    this.backendState.activeBackend = activeBackend;
    this.backendState.apiKeysAvailable = apiKeysAvailable;
    this.backendState.codexAvailable = this.isCliAvailable();
    if (!this.backendState.codexAvailable) {
      this.started = false;
      this.running = false;
      this.pendingSignInId = null;
      this.backendState.codexAuthenticated = false;
      this.backendState.codexAuthMode = null;
      this.backendState.codexEmail = undefined;
      this.backendState.codexPlanType = null;
      this.backendState.codexRateLimit = null;
      this.backendState.codexSignInPending = false;
      this.backendState.codexError = null;
    }
    this.emitBackendState();
  }

  private emitBackendState(): void {
    this.emitMessage({type: 'backendState', state: {...this.backendState}});
  }

  private emitMessage(message: ToWebviewMessage): void {
    emitBackendMessage(this, message);
  }

  private emitTaskEvent(message: ToWebviewMessage): void {
    if (PERSISTED_EVENT_TYPES.has(message.type)) {
      this.currentReplayEvents.push(message);
    }
    this.emitMessage(message);
  }

  private handleSessionMessage(message: ToWebviewMessage): void {
    if (SESSION_RESPONSE_TYPES.has(message.type)) return;
    this.emitMessage(message);
  }

  private ensureSessionStore(workDir: string): boolean {
    this.workDir = workDir || this.workDir || process.cwd();
    if (this.sessionStore.start(this.workDir)) {
      return true;
    }
    this.backendState.codexError = 'Could not start the KISS session store.';
    this.emitBackendState();
    this.emitMessage({type: 'error', text: this.backendState.codexError});
    return false;
  }

  private async safeGetModelUsage(): Promise<{
    usage: Record<string, number>;
    lastModel: string;
  }> {
    if (!this.ensureSessionStore(this.workDir || process.cwd())) {
      return {usage: {}, lastModel: ''};
    }
    try {
      return await this.sessionStore.getModelUsage();
    } catch {
      return {usage: {}, lastModel: ''};
    }
  }

  private async refreshAccountState(): Promise<void> {
    if (!this.started) return;
    const response = await this.client.request<{
      account: CodexAccount | null;
      requiresOpenaiAuth: boolean;
    }>('account/read', {refreshToken: false});
    const account = response.account;
    this.backendState.codexAuthenticated = !!account;
    this.backendState.codexAuthMode =
      account?.type === 'chatgpt' ? 'chatgpt' : account ? 'apikey' : null;
    this.backendState.codexEmail =
      account?.type === 'chatgpt' ? account.email : undefined;
    this.backendState.codexPlanType =
      account?.type === 'chatgpt' ? account.planType : null;
    this.backendState.codexError = null;
    this.backendState.codexAvailable = true;
    this.backendState.codexSignInPending = false;
    if (account?.type === 'chatgpt') {
      const limits = await this.client.request<RateLimitsResponse>(
        'account/rateLimits/read',
      );
      this.backendState.codexRateLimit = this.toRateLimitInfo(
        limits.rateLimits,
      );
    } else {
      this.backendState.codexRateLimit = null;
    }
    this.emitBackendState();
  }

  private pickSelectedModel(lastModel: string): string {
    if (
      lastModel &&
      this.codexModels.some(model => model.model === lastModel)
    ) {
      return lastModel;
    }
    if (this.codexModels.some(model => model.model === this.selectedModel)) {
      return this.selectedModel;
    }
    return (
      this.codexModels.find(model => model.isDefault)?.model ||
      this.codexModels[0]?.model ||
      'gpt-5.4'
    );
  }

  private async buildUserInput(
    prompt: string,
    attachments: Array<{mimeType: string; data: string; name?: string}>,
  ): Promise<Array<Record<string, unknown>>> {
    const input: Array<Record<string, unknown>> = [
      {type: 'text', text: prompt, text_elements: []},
    ];
    if (!attachments.length) return input;

    const dir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'kiss-codex-'),
    );
    this.cleanupDirs.add(dir);

    for (const [index, attachment] of attachments.entries()) {
      const extension = attachment.mimeType.split('/')[1] || 'bin';
      const filename = attachment.name || `upload-${index}.${extension}`;
      const filePath = path.join(dir, filename);
      await fs.promises.writeFile(
        filePath,
        Buffer.from(attachment.data, 'base64'),
      );
      input.push({type: 'localImage', path: filePath});
    }

    return input;
  }

  private async handleNotification(message: {
    method: string;
    params?: unknown;
  }): Promise<void> {
    switch (message.method) {
      case 'account/updated': {
        const params = message.params as {
          authMode?: BackendState['codexAuthMode'];
          planType?: string | null;
        };
        this.backendState.codexAuthMode =
          params.authMode ?? this.backendState.codexAuthMode;
        this.backendState.codexPlanType =
          params.planType ?? this.backendState.codexPlanType;
        this.emitBackendState();
        return;
      }
      case 'account/login/completed': {
        const params = message.params as {
          loginId: string | null;
          success: boolean;
          error: string | null;
        };
        if (!this.pendingSignInId || params.loginId !== this.pendingSignInId)
          return;
        this.pendingSignInId = null;
        this.backendState.codexSignInPending = false;
        if (!params.success) {
          this.backendState.codexError =
            params.error || 'ChatGPT sign-in failed';
          this.emitBackendState();
          this.emitMessage({type: 'error', text: this.backendState.codexError});
          return;
        }
        await this.refreshAccountState();
        await this.requestModels();
        this.events.emit('signInCompleted', {success: true});
        return;
      }
      case 'account/rateLimits/updated': {
        const params = message.params as {
          rateLimits: RateLimitsResponse['rateLimits'];
        };
        this.backendState.codexRateLimit = this.toRateLimitInfo(
          params.rateLimits,
        );
        this.emitBackendState();
        return;
      }
      case 'item/started': {
        this.handleItemStarted(
          (message.params as {item: CodexThreadItem}).item,
        );
        return;
      }
      case 'item/agentMessage/delta': {
        const params = message.params as {itemId: string; delta: string};
        const phase = this.itemPhases.get(params.itemId) ?? 'final_answer';
        if (phase === 'final_answer') {
          this.currentFinalText += params.delta;
        }
        this.emitTaskEvent({type: 'text_delta', text: params.delta});
        return;
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const params = message.params as {delta: string};
        this.emitTaskEvent({type: 'thinking_delta', text: params.delta});
        return;
      }
      case 'item/completed': {
        this.handleItemCompleted(
          (message.params as {item: CodexThreadItem}).item,
        );
        return;
      }
      case 'thread/tokenUsage/updated': {
        const params = message.params as {
          tokenUsage?: {
            last?: {
              totalTokens?: number;
              outputTokens?: number;
              reasoningOutputTokens?: number;
            };
          };
        };
        this.currentTokenUsage = params.tokenUsage?.last ?? null;
        return;
      }
      case 'turn/completed': {
        const params = message.params as {
          turn: {status: string; error: {message?: string | null} | null};
        };
        await this.finishTurn(params.turn);
        return;
      }
      case 'error': {
        const params = message.params as {message?: string};
        if (params.message) {
          this.emitMessage({type: 'error', text: params.message});
        }
        return;
      }
      default:
        return;
    }
  }

  private handleItemStarted(item: CodexThreadItem): void {
    switch (item.type) {
      case 'agentMessage':
        this.itemPhases.set(item.id, item.phase);
        return;
      case 'reasoning':
        this.emitTaskEvent({type: 'thinking_start'});
        return;
      case 'commandExecution':
        this.emitTaskEvent({
          type: 'tool_call',
          name: 'Bash',
          command: item.command,
          path: item.cwd,
        });
        return;
      case 'fileChange':
        for (const change of item.changes) {
          this.emitTaskEvent({
            type: 'tool_call',
            name: 'Edit',
            path: change.path,
            lang: 'diff',
            content: change.diff,
            description: change.kind,
          });
        }
        return;
      case 'mcpToolCall':
        this.emitTaskEvent({
          type: 'tool_call',
          name: `${item.server}:${item.tool}`,
          lang: 'json',
          content: JSON.stringify(item.arguments, null, 2),
        });
        return;
      case 'dynamicToolCall':
        this.emitTaskEvent({
          type: 'tool_call',
          name: item.tool,
          lang: 'json',
          content: JSON.stringify(item.arguments, null, 2),
        });
        return;
      default:
        return;
    }
  }

  private handleItemCompleted(item: CodexThreadItem): void {
    switch (item.type) {
      case 'reasoning':
        this.emitTaskEvent({type: 'thinking_end'});
        return;
      case 'commandExecution':
        if (item.aggregatedOutput) {
          this.emitTaskEvent({
            type: 'system_output',
            text: item.aggregatedOutput,
          });
        }
        this.emitTaskEvent({
          type: 'tool_result',
          content: item.aggregatedOutput || item.status,
          is_error: item.status === 'failed',
        });
        return;
      case 'fileChange':
        this.emitTaskEvent({
          type: 'tool_result',
          content:
            item.status === 'completed'
              ? 'File changes applied'
              : `File changes ${item.status}`,
          is_error: item.status === 'failed',
        });
        return;
      case 'mcpToolCall':
        this.emitTaskEvent({
          type: 'tool_result',
          content:
            item.error?.message || JSON.stringify(item.result ?? {}, null, 2),
          is_error: item.status === 'failed',
        });
        return;
      case 'dynamicToolCall': {
        const text = (item.contentItems ?? [])
          .map(entry => entry.text || '')
          .filter(Boolean)
          .join('\n');
        this.emitTaskEvent({
          type: 'tool_result',
          content: text || item.status,
          is_error: item.status === 'failed' || item.success === false,
        });
        return;
      }
      default:
        return;
    }
  }

  private async finishTurn(turn: {
    status: string;
    error: {message?: string | null} | null;
  }): Promise<void> {
    const usage = this.currentTokenUsage;
    const resultText = this.currentFinalText.trim();

    if (resultText) {
      this.emitTaskEvent({type: 'text_end'});
      this.emitTaskEvent({
        type: 'result',
        text: resultText,
        total_tokens: usage?.totalTokens ?? 0,
        cost: 'Included',
      });
    }
    if (usage) {
      this.emitTaskEvent({
        type: 'usage_info',
        total_tokens: usage.totalTokens ?? 0,
        cost: 'Included',
      });
    }

    const taskId = this.currentTaskId;
    const task = this.currentTask;
    const persistedEvents = [...this.currentReplayEvents];
    const resultSummary = this.buildResultSummary(turn, resultText);
    let persisted = false;

    this.running = false;
    this.currentThreadId = null;
    this.currentTurnId = null;
    this.currentTaskId = null;
    this.currentTask = null;
    this.currentFinalText = '';
    this.currentTokenUsage = null;
    this.currentReplayEvents = [];

    try {
      if (taskId !== null && task) {
        await this.sessionStore.persistCodexTask(
          taskId,
          task,
          resultSummary,
          persistedEvents,
          this.selectedModel,
          turn.status,
          turn.error?.message ?? null,
        );
        persisted = true;
      }
    } catch (error) {
      this.emitMessage({
        type: 'error',
        text: `Failed to persist Codex task: ${normalizeError(error)}`,
      });
    }

    this.emitMessage({type: 'status', running: false});

    if (!persisted) {
      if (turn.status === 'failed') {
        this.emitMessage({
          type: 'task_error',
          text: turn.error?.message || 'Codex turn failed',
        });
      } else if (turn.status !== 'completed') {
        this.emitMessage({type: 'task_stopped'});
      } else {
        this.emitMessage({type: 'task_done'});
      }
    }

    await this.requestModels().catch(() => undefined);
    await this.cleanupUploads();
  }

  private buildResultSummary(
    turn: {status: string; error: {message?: string | null} | null},
    resultText: string,
  ): string {
    if (turn.status === 'failed') {
      return 'Task failed';
    }
    if (turn.status !== 'completed') {
      return 'Task stopped';
    }
    return clipResultSummary(resultText);
  }

  private async handleServerRequest(request: {
    id: number;
    method: string;
    params?: unknown;
  }): Promise<void> {
    switch (request.method) {
      case 'item/tool/requestUserInput': {
        const params = request.params as {
          questions?: Array<{id: string; question: string}>;
        };
        const questions = params.questions ?? [];
        const firstQuestion = questions[0];
        if (!firstQuestion) {
          this.client.respond(request.id, {answers: {}});
          return;
        }
        this.pendingUserInput = {
          requestId: request.id,
          questionIds: questions.map(question => question.id),
        };
        this.emitMessage({type: 'askUser', question: firstQuestion.question});
        return;
      }
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.client.respond(request.id, 'decline');
        this.emitMessage({
          type: 'error',
          text: 'Codex requested an approval even though approvals are disabled for this backend.',
        });
        return;
      default:
        this.client.respond(request.id, {});
    }
  }

  private toRateLimitInfo(
    rateLimits: RateLimitsResponse['rateLimits'],
  ): CodexRateLimitInfo {
    return {
      limitId: rateLimits.limitId,
      planType: rateLimits.planType ?? null,
      primaryUsedPercent: rateLimits.primary?.usedPercent ?? null,
      primaryResetsAt: rateLimits.primary?.resetsAt ?? null,
      secondaryUsedPercent: rateLimits.secondary?.usedPercent ?? null,
      secondaryResetsAt: rateLimits.secondary?.resetsAt ?? null,
    };
  }

  private async cleanupUploads(): Promise<void> {
    const dirs = Array.from(this.cleanupDirs);
    this.cleanupDirs.clear();
    await Promise.all(
      dirs.map(async dir => {
        try {
          await fs.promises.rm(dir, {recursive: true, force: true});
        } catch {
          // Ignore cleanup failures.
        }
      }),
    );
  }
}
