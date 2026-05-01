import {ChildProcess, spawn} from 'child_process';
import {EventEmitter} from 'events';
import {findCodexPath} from './CodexBinary';

type JsonRpcId = number;

type JsonRpcError = {
  code: number;
  message: string;
};

type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
  timestamp?: string;
  level?: string;
  fields?: Record<string, unknown>;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

export interface CodexClientOptions {
  codexPath?: string;
  env?: NodeJS.ProcessEnv;
}

export class CodexAppServerClient extends EventEmitter {
  private readonly options: CodexClientOptions;
  private process: ChildProcess | null = null;
  private buffer = '';
  private nextRequestId = 1;
  private pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private startPromise: Promise<void> | null = null;

  constructor(options: CodexClientOptions = {}) {
    super();
    this.options = options;
  }

  async start(workDir: string): Promise<void> {
    if (this.process) return;
    if (this.startPromise) return await this.startPromise;

    this.startPromise = this.startInner(workDir);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInner(workDir: string): Promise<void> {
    const codexPath = this.options.codexPath || findCodexPath();
    if (!codexPath) {
      throw new Error('Codex CLI was not found on PATH.');
    }

    this.process = spawn(codexPath, ['app-server'], {
      cwd: workDir,
      env: {...process.env, ...this.options.env},
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk.toString());
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      this.emit('log', {stream: 'stderr', text});
    });

    this.process.on('close', (code, signal) => {
      const error = new Error(
        `Codex app-server exited (code=${code}, signal=${signal ?? 'none'})`,
      );
      this.rejectPendingRequests(error);
      this.process = null;
      this.buffer = '';
      this.emit('exit', error);
    });

    this.process.on('error', error => {
      this.rejectPendingRequests(error);
      this.process = null;
      this.emit('exit', error);
    });

    await this.request('initialize', {
      clientInfo: {name: 'kiss-sorcar', version: '0.0.0'},
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: null,
      },
    });
  }

  async request<T>(
    method: string,
    params?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!this.process?.stdin?.writable) {
      throw new Error('Codex app-server is not running');
    }

    const id = this.nextRequestId++;
    const payload = params === undefined ? {id, method} : {id, method, params};

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        method,
        resolve: value => resolve(value as T),
        reject,
        timer,
      });

      this.write(payload);
    });
  }

  respond(id: JsonRpcId, result?: unknown, error?: JsonRpcError): void {
    if (error) {
      this.write({id, error});
      return;
    }
    this.write({id, result: result ?? {}});
  }

  dispose(): void {
    this.rejectPendingRequests(new Error('Codex app-server client disposed'));
    const proc = this.process;
    this.process = null;
    this.buffer = '';
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
      // Ignore shutdown errors.
    }
    try {
      proc.kill();
    } catch {
      // Ignore shutdown errors.
    }
  }

  private write(message: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('Codex app-server is not running');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleLine(trimmed);
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit('log', {stream: 'stdout', text: line});
      return;
    }

    if (message.timestamp && message.level) {
      this.emit('log', message);
      return;
    }

    if (
      typeof message.id === 'number' &&
      ('result' in message || 'error' in message)
    ) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }

    if (typeof message.method === 'string' && typeof message.id === 'number') {
      this.emit('serverRequest', {
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    if (typeof message.method === 'string') {
      this.emit('notification', {
        method: message.method,
        params: message.params,
      });
      return;
    }

    this.emit('log', {stream: 'stdout', text: line});
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(`${pending.method}: ${response.error.message}`));
      return;
    }
    pending.resolve(response.result);
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
