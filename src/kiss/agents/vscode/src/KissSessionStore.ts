import {EventEmitter} from 'events';
import {AgentProcess} from './AgentProcess';
import {HistoryQuery} from './Backends';
import {SessionInfo, ToWebviewMessage} from './types';

type InternalMessage =
  | ToWebviewMessage
  | {
      type: 'codexTaskPrepared';
      prompt: string;
      task: string;
      taskId: number;
      workDir?: string;
      useWorktree?: boolean;
      useParallel?: boolean;
      chatId?: string | number;
    }
  | {type: 'codexTaskPersisted'; taskId: number}
  | {type: 'modelUsage'; usage: Record<string, number>; lastModel: string};

type Waiter = {
  predicate: (message: InternalMessage) => boolean;
  resolve: (message: InternalMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export interface PreparedCodexTask {
  task: string;
  prompt: string;
  taskId: number;
  workDir: string;
  useWorktree: boolean;
  useParallel: boolean;
  chatId: string;
}

export interface CodexTaskOptions {
  useWorktree?: boolean;
  useParallel?: boolean;
  skipMerge?: boolean;
}

export interface ModelUsageState {
  usage: Record<string, number>;
  lastModel: string;
}

export interface KissSessionStore {
  readonly events?: EventEmitter;
  start(workDir: string): boolean;
  dispose(): void;
  newChat(): Promise<void>;
  prepareCodexTask(
    prompt: string,
    workDir: string,
    options?: CodexTaskOptions,
  ): Promise<PreparedCodexTask>;
  persistCodexTask(
    taskId: number,
    task: string,
    result: string,
    events: ToWebviewMessage[],
    model: string,
    status: string,
    error?: string | null,
  ): Promise<void>;
  finishMerge(tabId: string): Promise<void> | void;
  worktreeAction(
    action: 'merge' | 'discard',
    tabId: string,
  ): Promise<void> | void;
  autocommitAction(
    action: 'commit' | 'skip',
    tabId: string,
  ): Promise<void> | void;
  getHistory(
    query: HistoryQuery,
  ): Promise<{sessions: SessionInfo[]; offset?: number; generation?: number}>;
  getLastSession(): Promise<{
    events: ToWebviewMessage[];
    task?: string;
    chatId?: string;
  } | null>;
  resumeSession(id: string): Promise<{
    events: ToWebviewMessage[];
    task?: string;
    chatId?: string;
  } | null>;
  getInputHistory(): Promise<string[]>;
  getFiles(prefix: string): Promise<Array<{type: string; text: string}>>;
  recordFileUsage(path: string): void;
  selectModel(model: string): void;
  closeTab?(tabId: string): void;
  getModelUsage(): Promise<ModelUsageState>;
}

export class AgentProcessKissSessionStore implements KissSessionStore {
  readonly events = new EventEmitter();
  private readonly process: AgentProcess;
  private readonly tabId: string;
  private readonly onMessage: (message: InternalMessage) => void;
  private readonly waiters = new Set<Waiter>();

  constructor(process: AgentProcess, tabId = '') {
    this.process = process;
    this.tabId = tabId;
    this.onMessage = message => {
      for (const waiter of Array.from(this.waiters)) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message);
        break;
      }
      this.events.emit('message', message);
    };
    this.process.on('message', this.onMessage);
  }

  start(workDir: string): boolean {
    return this.process.start(workDir);
  }

  dispose(): void {
    this.process.off('message', this.onMessage);
    for (const waiter of Array.from(this.waiters)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('KISS session store disposed'));
      this.waiters.delete(waiter);
    }
    this.events.removeAllListeners();
    this.process.dispose();
  }

  async newChat(): Promise<void> {
    this.sendCommand({type: 'newChat'});
  }

  async prepareCodexTask(
    prompt: string,
    workDir: string,
    options: CodexTaskOptions = {},
  ): Promise<PreparedCodexTask> {
    const pending = this.waitFor(
      message => message.type === 'codexTaskPrepared',
    );
    this.sendCommand({
      type: 'prepareCodexTask',
      prompt,
      workDir,
      useWorktree: !!options.useWorktree,
      useParallel: !!options.useParallel,
      skipMerge: !!options.skipMerge,
    });
    const message = (await pending) as Extract<
      InternalMessage,
      {type: 'codexTaskPrepared'}
    >;
    return {
      task: message.task,
      prompt: message.prompt,
      taskId: message.taskId,
      workDir: message.workDir || workDir,
      useWorktree: !!message.useWorktree,
      useParallel: !!message.useParallel,
      chatId: message.chatId !== undefined ? String(message.chatId) : '',
    };
  }

  async persistCodexTask(
    taskId: number,
    task: string,
    result: string,
    events: ToWebviewMessage[],
    model: string,
    status: string,
    error?: string | null,
  ): Promise<void> {
    const pending = this.waitFor(
      message =>
        message.type === 'codexTaskPersisted' && message.taskId === taskId,
    );
    this.sendCommand({
      type: 'persistCodexTask',
      taskId,
      prompt: task,
      result,
      events,
      model,
      status,
      error,
    });
    await pending;
  }

  async finishMerge(tabId: string): Promise<void> {
    this.sendCommand({type: 'mergeAction', action: 'all-done', tabId});
  }

  async worktreeAction(
    action: 'merge' | 'discard',
    tabId: string,
  ): Promise<void> {
    this.sendCommand({type: 'worktreeAction', action, tabId});
  }

  async autocommitAction(
    action: 'commit' | 'skip',
    tabId: string,
  ): Promise<void> {
    this.sendCommand({type: 'autocommitAction', action, tabId});
  }

  async getHistory(
    query: HistoryQuery,
  ): Promise<{sessions: SessionInfo[]; offset?: number; generation?: number}> {
    const pending = this.waitFor(message => message.type === 'history');
    this.sendCommand({
      type: 'getHistory',
      query: query.query,
      offset: query.offset,
      generation: query.generation,
    });
    const message = (await pending) as Extract<
      InternalMessage,
      {type: 'history'}
    >;
    return {
      sessions: message.sessions,
      offset: message.offset,
      generation: message.generation,
    };
  }

  async getLastSession(): Promise<{
    events: ToWebviewMessage[];
    task?: string;
    chatId?: string;
  } | null> {
    const history = await this.getHistory({offset: 0, generation: 0});
    const first = history.sessions[0];
    if (!first) return null;
    return await this.resumeSession(String(first.id));
  }

  async resumeSession(id: string): Promise<{
    events: ToWebviewMessage[];
    task?: string;
    chatId?: string;
  } | null> {
    const pending = this.waitFor(message => message.type === 'task_events');
    this.sendCommand({type: 'resumeSession', chatId: id});
    const message = (await pending) as Extract<
      InternalMessage,
      {type: 'task_events'}
    >;
    return {
      events: message.events as ToWebviewMessage[],
      task: message.task,
      chatId: message.chat_id !== undefined ? String(message.chat_id) : id,
    };
  }

  async getInputHistory(): Promise<string[]> {
    const pending = this.waitFor(message => message.type === 'inputHistory');
    this.sendCommand({type: 'getInputHistory'});
    const message = (await pending) as Extract<
      InternalMessage,
      {type: 'inputHistory'}
    >;
    return message.tasks;
  }

  async getFiles(prefix: string): Promise<Array<{type: string; text: string}>> {
    const pending = this.waitFor(message => message.type === 'files');
    this.sendCommand({type: 'getFiles', prefix});
    const message = (await pending) as Extract<
      InternalMessage,
      {type: 'files'}
    >;
    return message.files;
  }

  recordFileUsage(path: string): void {
    this.sendCommand({type: 'recordFileUsage', path});
  }

  selectModel(model: string): void {
    this.sendCommand({type: 'selectModel', model});
  }

  closeTab(tabId: string): void {
    if (!this.process.isAlive) return;
    this.sendCommand({type: 'closeTab', tabId});
  }

  async getModelUsage(): Promise<ModelUsageState> {
    const pending = this.waitFor(message => message.type === 'modelUsage');
    this.sendCommand({type: 'getModelUsage'});
    const message = (await pending) as Extract<
      InternalMessage,
      {type: 'modelUsage'}
    >;
    return {
      usage: message.usage,
      lastModel: message.lastModel,
    };
  }

  private async waitFor(
    predicate: (message: InternalMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<InternalMessage> {
    return await new Promise<InternalMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = typedWaiter;
        this.waiters.delete(waiter);
        reject(new Error('Timed out waiting for KISS session response'));
      }, timeoutMs);

      const typedWaiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer,
      };
      this.waiters.add(typedWaiter);
    });
  }

  private sendCommand(cmd: Parameters<AgentProcess['sendCommand']>[0]): void {
    this.process.sendCommand(this.tabId ? {...cmd, tabId: this.tabId} : cmd);
  }
}
