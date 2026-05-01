#!/usr/bin/env node

const readline = require('node:readline');

if (process.argv[2] !== 'app-server') {
  console.error(`Unsupported args: ${process.argv.slice(2).join(' ')}`);
  process.exit(1);
}

let loggedIn = process.env.FAKE_CODEX_LOGGED_IN !== '0';
let pendingSignInId = null;
let loginCounter = 0;
let threadCounter = 0;
let turnCounter = 0;
const threads = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function makeThread(id, cwd) {
  return {
    id,
    preview: '',
    name: null,
    updatedAt: Math.floor(Date.now() / 1000),
    cwd,
    turns: [],
  };
}

function buildThreadSnapshot(thread) {
  return {
    id: thread.id,
    preview: thread.preview,
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: thread.updatedAt,
    updatedAt: thread.updatedAt,
    status: { type: 'idle' },
    path: null,
    cwd: thread.cwd,
    cliVersion: '0.0.0-test',
    source: 'vscode',
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name,
    turns: thread.turns,
  };
}

function modelList() {
  return [
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
}

function rateLimits() {
  return {
    limitId: 'codex',
    planType: loggedIn ? 'pro' : 'unknown',
    primary: { usedPercent: 2, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
    secondary: { usedPercent: 3, resetsAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 },
  };
}

function startTurn(params) {
  const thread = threads.get(params.threadId);
  const turnId = `turn-${++turnCounter}`;
  const prompt = params.input[0].text;
  const finalText = prompt.includes('commit message')
    ? 'fix: add codex backend auth support'
    : 'Hello from fake Codex.';
  const userItem = {
    type: 'userMessage',
    id: `user-${turnCounter}`,
    content: params.input,
  };
  const reasoningItem = {
    type: 'reasoning',
    id: `reason-${turnCounter}`,
    summary: [],
    content: ['Looking at the request.'],
  };
  const agentItem = {
    type: 'agentMessage',
    id: `agent-${turnCounter}`,
    text: finalText,
    phase: 'final_answer',
    memoryCitation: null,
  };
  const turn = {
    id: turnId,
    items: [userItem, reasoningItem, agentItem],
    status: 'completed',
    error: null,
  };
  thread.preview = thread.preview || prompt;
  thread.updatedAt = Math.floor(Date.now() / 1000);
  thread.turns.push(turn);

  send({ id: params.__requestId, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
  send({ method: 'turn/started', params: { threadId: thread.id, turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
  send({ method: 'item/started', params: { threadId: thread.id, turnId, item: userItem } });
  send({ method: 'item/completed', params: { threadId: thread.id, turnId, item: userItem } });
  send({ method: 'item/started', params: { threadId: thread.id, turnId, item: reasoningItem } });
  send({ method: 'item/reasoning/textDelta', params: { threadId: thread.id, turnId, itemId: reasoningItem.id, delta: 'Looking at the request.' } });
  send({ method: 'item/completed', params: { threadId: thread.id, turnId, item: reasoningItem } });
  send({ method: 'item/started', params: { threadId: thread.id, turnId, item: { ...agentItem, text: '' } } });
  for (const chunk of ['Hello', ' from', ' fake', ' Codex.']) {
    send({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId, itemId: agentItem.id, delta: chunk } });
  }
  send({ method: 'item/completed', params: { threadId: thread.id, turnId, item: agentItem } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: thread.id, turnId, tokenUsage: { last: { totalTokens: 123, outputTokens: 4, reasoningOutputTokens: 1 } } } });
  send({ method: 'account/rateLimits/updated', params: { rateLimits: rateLimits() } });
  send({ method: 'turn/completed', params: { threadId: thread.id, turn } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const { id, method, params } = message;

  if (method === 'initialize') {
    send({ id, result: { userAgent: 'fake-codex', platformFamily: 'unix', platformOs: 'macos' } });
    return;
  }

  if (method === 'account/read') {
    send({
      id,
      result: {
        account: loggedIn ? { type: 'chatgpt', email: 'tester@example.com', planType: 'pro' } : null,
        requiresOpenaiAuth: true,
      },
    });
    return;
  }

  if (method === 'account/rateLimits/read') {
    send({ id, result: { rateLimits: rateLimits(), rateLimitsByLimitId: { codex: rateLimits() } } });
    return;
  }

  if (method === 'account/login/start') {
    pendingSignInId = `signin-${++loginCounter}`;
    send({ id, result: { type: 'chatgpt', loginId: pendingSignInId, authUrl: 'https://example.com/signin' } });
    setTimeout(() => {
      loggedIn = true;
      send({ method: 'account/login/completed', params: { loginId: pendingSignInId, success: true, error: null } });
      send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'pro' } });
    }, 10);
    return;
  }

  if (method === 'account/logout') {
    loggedIn = false;
    send({ id, result: {} });
    send({ method: 'account/updated', params: { authMode: null, planType: null } });
    return;
  }

  if (method === 'model/list') {
    send({ id, result: { data: modelList(), nextCursor: null } });
    return;
  }

  if (method === 'thread/start') {
    const threadId = `thread-${++threadCounter}`;
    const thread = makeThread(threadId, params.cwd);
    threads.set(threadId, thread);
    send({ id, result: { thread: buildThreadSnapshot(thread), model: params.model || 'gpt-5.4' } });
    send({ method: 'thread/started', params: { thread: buildThreadSnapshot(thread) } });
    return;
  }

  if (method === 'thread/list') {
    const data = Array.from(threads.values())
      .filter(thread => !params.cwd || thread.cwd === params.cwd)
      .map(buildThreadSnapshot);
    send({ id, result: { data, nextCursor: null } });
    return;
  }

  if (method === 'thread/read') {
    const thread = threads.get(params.threadId);
    send({ id, result: { thread: buildThreadSnapshot(thread) } });
    return;
  }

  if (method === 'thread/resume') {
    const thread = threads.get(params.threadId);
    send({ id, result: { thread: buildThreadSnapshot(thread) } });
    return;
  }

  if (method === 'turn/start') {
    startTurn({ ...params, __requestId: id });
    return;
  }

  if (method === 'turn/interrupt') {
    send({ id, result: {} });
    return;
  }

  send({ id, result: {} });
});
