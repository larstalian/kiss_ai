const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { CodexAppServerClient } = require('../out/CodexAppServerClient');
const { CodexBackend } = require('../out/CodexBackend');

class MemoryStore {
  constructor() {
    this.values = new Map();
  }

  get(key, defaultValue) {
    return this.values.has(key) ? this.values.get(key) : defaultValue;
  }

  update(key, value) {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

class FakeKissSessionStore {
  constructor(overrides = {}) {
    this.events = new EventEmitter();
    this.overrides = overrides;
    this.started = [];
    this.prepareCalls = [];
    this.persistCalls = [];
    this.historyQueries = [];
    this.resumeCalls = [];
    this.filePrefixes = [];
    this.recordedFiles = [];
    this.selectedModels = [];
    this.mergeFinishes = [];
    this.worktreeActions = [];
    this.autocommitActions = [];
    this.newChatCalls = 0;
    this.closedTabs = [];
    this.disposeCalls = 0;
    this.nextTaskId = 1;
    this.usage = { 'gpt-5.4': 2, ...(overrides.usage || {}) };
    this.lastModel = overrides.lastModel || 'gpt-5.4';
  }

  start(workDir) {
    this.started.push(workDir);
    return true;
  }

  dispose() {
    this.disposeCalls += 1;
  }

  async newChat() {
    this.newChatCalls += 1;
  }

  async prepareCodexTask(prompt, workDir, options = {}) {
    if (this.overrides.prepareError) {
      throw this.overrides.prepareError;
    }
    this.prepareCalls.push({ prompt, workDir, options });
    this.lastWorkDir = workDir;
    const taskId = this.nextTaskId++;
    const preparedPrompt = this.overrides.preparePrompt
      ? this.overrides.preparePrompt(prompt, taskId)
      : `# Task (work on it now)\n\n${prompt}`;
    const preparedWorkDir = this.overrides.preparedWorkDir || workDir;
    return {
      task: prompt,
      prompt: preparedPrompt,
      taskId,
      workDir: preparedWorkDir,
      useWorktree: !!options.useWorktree && preparedWorkDir !== workDir,
      useParallel: !!options.useParallel,
      chatId: this.overrides.chatId || 'chat-codex',
    };
  }

  async persistCodexTask(taskId, task, result, events, model, status, error) {
    this.persistCalls.push({ taskId, task, result, events, model, status, error });
    this.usage[model] = (this.usage[model] || 0) + 1;
    this.lastModel = model;
    this.events.emit('message', { type: 'tasks_updated' });
    if (status === 'failed') {
      this.events.emit('message', { type: 'task_error', text: error || 'Codex turn failed' });
    } else if (status !== 'completed') {
      this.events.emit('message', { type: 'task_stopped' });
    } else {
      this.events.emit('message', { type: 'task_done' });
    }
  }

  async finishMerge(tabId) {
    this.mergeFinishes.push(tabId);
    this.events.emit('message', { type: 'merge_ended', tabId });
  }

  async worktreeAction(action, tabId) {
    this.worktreeActions.push({ action, tabId });
    this.events.emit('message', { type: 'worktree_result', success: true, message: 'ok', tabId });
  }

  async autocommitAction(action, tabId) {
    this.autocommitActions.push({ action, tabId });
  }

  async getHistory(query) {
    this.historyQueries.push(query);
    return {
      sessions: this.overrides.historySessions || [{
        id: 'history-task',
        title: 'History Task',
        timestamp: 1,
        preview: 'History Task',
        has_events: true,
      }],
      offset: query.offset ?? 0,
      generation: query.generation,
    };
  }

  async getLastSession() {
    return this.overrides.lastSession || {
      task: 'Last task',
      events: [{ type: 'prompt', text: 'last prompt' }],
      chatId: 'last-chat',
    };
  }

  async resumeSession(id) {
    this.resumeCalls.push(id);
    return this.overrides.resumeSession || {
      task: `Resume ${id}`,
      events: [{ type: 'prompt', text: `resume ${id}` }],
      chatId: id,
    };
  }

  async getInputHistory() {
    return this.overrides.inputHistory || ['first task', 'second task'];
  }

  async getFiles(prefix) {
    this.filePrefixes.push(prefix);
    return this.overrides.files || [{ type: 'file', text: 'src/app.ts' }];
  }

  recordFileUsage(filePath) {
    this.recordedFiles.push(filePath);
  }

  selectModel(model) {
    this.selectedModels.push(model);
    this.lastModel = model;
  }

  closeTab(tabId) {
    this.closedTabs.push(tabId);
  }

  async getModelUsage() {
    return {
      usage: this.usage,
      lastModel: this.lastModel,
    };
  }
}

class FakeCodexClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.account = options.account === undefined
      ? { type: 'chatgpt', email: 'tester@example.com', planType: 'pro' }
      : options.account;
    this.models = options.models || [
      {
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'gpt-5.4',
        description: 'Strong model for everyday coding.',
        hidden: false,
        isDefault: true,
      },
      {
        id: 'gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        displayName: 'GPT-5.4-Mini',
        description: 'Small, fast, and cost-efficient.',
        hidden: false,
        isDefault: false,
      },
    ];
    this.requests = [];
    this.responses = [];
    this.started = [];
    this.loginCounter = 0;
    this.threadCounter = 0;
    this.turnCounter = 0;
  }

  async start(workDir) {
    this.started.push(workDir);
  }

  async request(method, params = {}) {
    this.requests.push({ method, params });

    if (method === 'account/read') {
      return { account: this.account, requiresOpenaiAuth: true };
    }
    if (method === 'account/rateLimits/read') {
      return {
        rateLimits: {
          limitId: 'codex',
          planType: this.account?.planType || 'unknown',
          primary: { usedPercent: 2, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { usedPercent: 3, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
        },
      };
    }
    if (method === 'model/list') {
      return { data: this.models };
    }
    if (method === 'account/login/start') {
      const signInId = `signin-${++this.loginCounter}`;
      setTimeout(() => {
        this.account = { type: 'chatgpt', email: 'tester@example.com', planType: 'pro' };
        this.emit('notification', {
          method: 'account/login/completed',
          params: { loginId: signInId, success: true, error: null },
        });
        this.emit('notification', {
          method: 'account/updated',
          params: { authMode: 'chatgpt', planType: 'pro' },
        });
      }, 10);
      return {
        type: 'chatgpt',
        loginId: signInId,
        authUrl: 'https://example.com/signin',
      };
    }
    if (method === 'account/logout') {
      this.account = null;
      return {};
    }
    if (method === 'thread/start') {
      return { thread: { id: `thread-${++this.threadCounter}` } };
    }
    if (method === 'turn/start') {
      const turnId = `turn-${++this.turnCounter}`;
      setTimeout(() => {
        this.emit('notification', {
          method: 'item/started',
          params: { item: { type: 'reasoning', id: `reason-${turnId}`, summary: [], content: [] } },
        });
        this.emit('notification', {
          method: 'item/reasoning/textDelta',
          params: { itemId: `reason-${turnId}`, delta: 'Thinking about it.' },
        });
        this.emit('notification', {
          method: 'item/completed',
          params: { item: { type: 'reasoning', id: `reason-${turnId}`, summary: [], content: [] } },
        });
        this.emit('notification', {
          method: 'item/started',
          params: { item: { type: 'agentMessage', id: `agent-${turnId}`, text: '', phase: 'final_answer' } },
        });
        this.emit('notification', {
          method: 'item/agentMessage/delta',
          params: { itemId: `agent-${turnId}`, delta: 'Hello from fake Codex.' },
        });
        this.emit('notification', {
          method: 'item/completed',
          params: { item: { type: 'agentMessage', id: `agent-${turnId}`, text: 'Hello from fake Codex.', phase: 'final_answer' } },
        });
        this.emit('notification', {
          method: 'thread/tokenUsage/updated',
          params: { tokenUsage: { last: { totalTokens: 123, outputTokens: 4, reasoningOutputTokens: 1 } } },
        });
        this.emit('notification', {
          method: 'turn/completed',
          params: { turn: { status: 'completed', error: null } },
        });
      }, 10);
      return { turn: { id: turnId } };
    }
    if (method === 'turn/interrupt') {
      return {};
    }
    return {};
  }

  respond(id, payload) {
    this.responses.push({ id, payload });
  }

  dispose() {}
}

function fakeCodexPath() {
  const scriptPath = path.join(__dirname, 'fake-codex.js');
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function makeWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kiss-codex-test-'));
}

async function waitFor(check, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

test('CodexAppServerClient handles initialize, auth, and model listing', async () => {
  const workDir = makeWorkDir();
  const client = new CodexAppServerClient({ codexPath: fakeCodexPath() });
  const notifications = [];
  client.on('notification', notification => notifications.push(notification));

  await client.start(workDir);

  const account = await client.request('account/read', { refreshToken: false });
  assert.equal(account.account.type, 'chatgpt');
  assert.equal(account.account.email, 'tester@example.com');

  const models = await client.request('model/list', {});
  assert.equal(models.data.length, 2);
  assert.equal(models.data[0].model, 'gpt-5.4');

  const signIn = await client.request('account/login/start', { type: 'chatgpt' });
  assert.equal(signIn.type, 'chatgpt');
  assert.ok(signIn.authUrl);

  await waitFor(() => notifications.find(entry => entry.method === 'account/login/completed'));
  client.dispose();
});

test('CodexBackend uses KISS session state and fresh Codex threads per task', async () => {
  const workDir = makeWorkDir();
  const store = new MemoryStore();
  const sessionStore = new FakeKissSessionStore({
    preparePrompt(prompt, taskId) {
      return `## Previous tasks and results from the chat session for reference\n\n### Task ${taskId}\n${prompt}\n\n# Task (work on it now)\n\n${prompt}`;
    },
  });
  const client = new FakeCodexClient();
  const backend = new CodexBackend(store, client, () => true, sessionStore);
  const messages = [];
  backend.events.on('message', message => messages.push(message));

  const started = await backend.start(workDir);
  assert.equal(started, true);

  backend.setActiveBackend('codex', false);
  await backend.requestModels();
  const modelMessage = await waitFor(() => messages.find(message => message.type === 'models'));
  assert.equal(modelMessage.selected, 'gpt-5.4');
  assert.equal(modelMessage.models[0].uses, 2);

  await backend.submitTask({
    prompt: 'Say hi.',
    model: 'gpt-5.4',
    workDir,
    attachments: [],
    thinkingEffort: 'high',
    codexServiceTier: 'fast',
  });
  await waitFor(() => messages.filter(message => message.type === 'task_done').length === 1);

  await backend.submitTask({
    prompt: 'Say hi again.',
    model: 'gpt-5.4-mini',
    workDir,
    attachments: [],
    codexServiceTier: 'standard',
  });
  await waitFor(() => messages.filter(message => message.type === 'task_done').length === 2);

  await backend.submitTask({
    prompt: 'Use legacy tier.',
    model: 'gpt-5.4-mini',
    workDir,
    attachments: [],
    codexServiceTier: 'flex',
  });
  await waitFor(() => messages.filter(message => message.type === 'task_done').length === 3);

  const turnStarts = client.requests.filter(request => request.method === 'turn/start');
  const threadStarts = client.requests.filter(request => request.method === 'thread/start');
  assert.equal(threadStarts.length, 3);
  assert.equal(turnStarts.length, 3);
  assert.equal(
    turnStarts[0].params.input[0].text.includes('# Task (work on it now)'),
    true,
  );
  assert.equal(turnStarts[0].params.input[0].text.includes('Say hi.'), true);
  assert.equal(turnStarts[0].params.effort, 'high');
  assert.equal(threadStarts[0].params.serviceTier, 'fast');
  assert.equal(turnStarts[0].params.serviceTier, 'fast');
  assert.equal(
    turnStarts[1].params.input[0].text.includes('Say hi again.'),
    true,
  );
  assert.equal(turnStarts[1].params.effort, 'medium');
  assert.equal(
    Object.prototype.hasOwnProperty.call(threadStarts[1].params, 'serviceTier'),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(turnStarts[1].params, 'serviceTier'),
    false,
  );
  assert.equal(
    turnStarts[2].params.input[0].text.includes('Use legacy tier.'),
    true,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(threadStarts[2].params, 'serviceTier'),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(turnStarts[2].params, 'serviceTier'),
    false,
  );

  assert.equal(sessionStore.prepareCalls.length, 3);
  assert.equal(sessionStore.persistCalls.length, 3);
  assert.equal(sessionStore.persistCalls[0].task, 'Say hi.');
  assert.equal(sessionStore.persistCalls[0].model, 'gpt-5.4');
  assert.equal(sessionStore.persistCalls[0].result, 'Hello from fake Codex.');
  assert.ok(sessionStore.persistCalls[0].events.some(event => event.type === 'prompt'));
  assert.ok(sessionStore.persistCalls[0].events.some(event => event.type === 'result'));
  assert.deepEqual(sessionStore.selectedModels, []);
  assert.equal(
    messages.find(message => message.type === 'clear')?.chat_id,
    'chat-codex',
  );

  await backend.requestHistory({ query: 'hi', offset: 0, generation: 7 });
  const historyMessage = await waitFor(() => messages.find(message => message.type === 'history'));
  assert.equal(historyMessage.sessions[0].id, 'history-task');
  assert.deepEqual(sessionStore.historyQueries[0], { query: 'hi', offset: 0, generation: 7 });

  await backend.requestLastSession();
  const lastSession = await waitFor(() => messages.find(message => message.type === 'task_events' && message.task === 'Last task'));
  assert.equal(lastSession.events[0].text, 'last prompt');
  assert.equal(lastSession.chat_id, 'last-chat');

  await backend.resumeSession('history-task');
  const resumed = await waitFor(() => messages.find(message => message.type === 'task_events' && message.task === 'Resume history-task'));
  assert.equal(resumed.events[0].text, 'resume history-task');
  assert.equal(resumed.chat_id, 'history-task');
  assert.deepEqual(sessionStore.resumeCalls, ['history-task']);

  await backend.requestInputHistory();
  const inputHistory = await waitFor(() => messages.find(message => message.type === 'inputHistory'));
  assert.deepEqual(inputHistory.tasks, ['first task', 'second task']);

  await backend.requestFiles('app', workDir);
  const filesMessage = await waitFor(() => messages.find(message => message.type === 'files'));
  assert.deepEqual(filesMessage.files, [{ type: 'file', text: 'src/app.ts' }]);
  assert.deepEqual(sessionStore.filePrefixes, ['app']);

  backend.recordFileUsage('src/app.ts');
  assert.deepEqual(sessionStore.recordedFiles, ['src/app.ts']);

  await backend.newChat();
  assert.equal(sessionStore.newChatCalls, 1);

  const forbiddenMethods = client.requests
    .map(request => request.method)
    .filter(method => method === 'thread/list' || method === 'thread/read' || method === 'thread/resume');
  assert.deepEqual(forbiddenMethods, []);

  backend.dispose();
});

test('CodexBackend leaves model usage to task persistence on submit', async () => {
  const workDir = makeWorkDir();
  const sessionStore = new FakeKissSessionStore();
  const client = new FakeCodexClient();
  const backend = new CodexBackend(new MemoryStore(), client, () => true, sessionStore);

  await backend.submitTask({
    prompt: 'Count once.',
    model: 'gpt-5.4',
    workDir,
    attachments: [],
  });
  await waitFor(() => sessionStore.persistCalls.length === 1);

  assert.deepEqual(sessionStore.selectedModels, []);
  assert.equal(sessionStore.usage['gpt-5.4'], 3);

  backend.dispose();
});

test('CodexBackend clears running state when KISS task prep fails', async () => {
  const workDir = makeWorkDir();
  const sessionStore = new FakeKissSessionStore({
    prepareError: new Error('prep failed'),
  });
  const client = new FakeCodexClient();
  const backend = new CodexBackend(new MemoryStore(), client, () => true, sessionStore);
  const messages = [];
  backend.events.on('message', message => messages.push(message));

  await backend.submitTask({
    prompt: 'Will fail before Codex turn.',
    model: 'gpt-5.4',
    workDir,
    attachments: [],
  });

  assert.equal(sessionStore.persistCalls.length, 0);
  assert.equal(client.requests.some(request => request.method === 'turn/start'), false);
  assert.ok(messages.some(message => message.type === 'error' && message.text.includes('prep failed')));
  assert.ok(messages.some(message => message.type === 'status' && message.running === false));

  backend.dispose();
});

test('CodexBackend closeTab closes and disposes owned session stores', () => {
  const sessionStore = new FakeKissSessionStore();
  const client = new FakeCodexClient();
  const backend = new CodexBackend(
    new MemoryStore(),
    client,
    () => true,
    sessionStore,
    true,
  );

  backend.closeTab('tab-codex');

  assert.deepEqual(sessionStore.closedTabs, ['tab-codex']);
  assert.equal(sessionStore.disposeCalls, 1);
});

test('CodexBackend routes KISS execution toggles through session prep', async () => {
  const workDir = makeWorkDir();
  const preparedWorkDir = path.join(workDir, '.kiss-worktrees', 'kiss_wt_tab');
  fs.mkdirSync(preparedWorkDir, { recursive: true });
  const store = new MemoryStore();
  const sessionStore = new FakeKissSessionStore({ preparedWorkDir });
  const client = new FakeCodexClient();
  const backend = new CodexBackend(store, client, () => true, sessionStore);

  const started = await backend.start(workDir);
  assert.equal(started, true);

  await backend.submitTask({
    prompt: 'Use the KISS toggles.',
    model: 'gpt-5.4',
    workDir,
    attachments: [],
    useWorktree: true,
    useParallel: true,
    skipMerge: true,
    thinkingEffort: 'xhigh',
    codexServiceTier: 'fast',
  });
  await waitFor(() => sessionStore.persistCalls.length === 1);

  assert.deepEqual(sessionStore.prepareCalls[0], {
    prompt: 'Use the KISS toggles.',
    workDir,
    options: { useWorktree: true, useParallel: true, skipMerge: true },
  });

  const threadStart = client.requests.find(request => request.method === 'thread/start');
  const turnStart = client.requests.find(request => request.method === 'turn/start');
  assert.equal(threadStart.params.cwd, preparedWorkDir);
  assert.equal(turnStart.params.cwd, preparedWorkDir);
  assert.deepEqual(turnStart.params.sandboxPolicy.writableRoots, [preparedWorkDir]);
  assert.equal(turnStart.params.effort, 'xhigh');
  assert.equal(threadStart.params.serviceTier, 'fast');
  assert.equal(turnStart.params.serviceTier, 'fast');

  await backend.worktreeAction('merge', 'tab-wt');
  assert.deepEqual(sessionStore.worktreeActions, [{ action: 'merge', tabId: 'tab-wt' }]);

  backend.dispose();
});

test('CodexBackend supports first-time ChatGPT sign-in without eager model loading', async () => {
  const workDir = makeWorkDir();
  const store = new MemoryStore();
  const sessionStore = new FakeKissSessionStore();
  const client = new FakeCodexClient({ account: null });
  const backend = new CodexBackend(store, client, () => true, sessionStore);
  const messages = [];
  backend.events.on('message', message => messages.push(message));

  const started = await backend.start(workDir);
  assert.equal(started, true);
  assert.equal(backend.isAuthenticated(), false);

  backend.setActiveBackend('codex', false);
  await backend.requestModels();
  const emptyModels = await waitFor(() => messages.find(message => message.type === 'models'));
  assert.deepEqual(emptyModels.models, []);

  const authUrl = await backend.signInWithChatGpt();
  assert.equal(authUrl, 'https://example.com/signin');
  await waitFor(() => backend.isAuthenticated());

  await backend.requestModels();
  const modelMessages = messages.filter(message => message.type === 'models');
  assert.equal(modelMessages.at(-1).models[0].name, 'gpt-5.4');

  backend.dispose();
});
