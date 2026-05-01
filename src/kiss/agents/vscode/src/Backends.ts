import {EventEmitter} from 'events';
import {
  Attachment,
  BackendId,
  CodexReasoningEffort,
  CodexServiceTier,
  ToWebviewMessage,
} from './types';

export interface SubmitTaskParams {
  prompt: string;
  model: string;
  workDir: string;
  activeFile?: string;
  activeFileContent?: string;
  attachments?: Attachment[];
  useWorktree?: boolean;
  useParallel?: boolean;
  skipMerge?: boolean;
  thinkingEffort?: CodexReasoningEffort;
  codexServiceTier?: CodexServiceTier;
}

export interface HistoryQuery {
  query?: string;
  offset?: number;
  generation?: number;
}

export interface ChatBackend {
  readonly id: BackendId;
  readonly events: EventEmitter;
  isRunning(): boolean;
  start(workDir: string): Promise<boolean> | boolean;
  dispose(): void;
  submitTask(params: SubmitTaskParams): Promise<void>;
  stopTask(): void;
  selectModel(model: string): Promise<void> | void;
  requestModels(): Promise<void>;
  requestHistory(query: HistoryQuery): Promise<void>;
  requestLastSession(): Promise<void>;
  requestFiles(prefix: string, workDir: string): Promise<void>;
  recordFileUsage(path: string): Promise<void> | void;
  resumeSession(id: string): Promise<void>;
  newChat(): Promise<void> | void;
  requestInputHistory(): Promise<void>;
  requestGhostSuggestion(
    query: string,
    activeFile?: string,
    activeFileContent?: string,
  ): Promise<void>;
  answerUserInput(answer: string): Promise<void> | void;
  generateCommitMessage?(
    workDir: string,
  ): Promise<{message: string; error?: string}>;
}

export function emitBackendMessage(
  backend: ChatBackend,
  message: ToWebviewMessage,
): void {
  backend.events.emit('message', message);
}
