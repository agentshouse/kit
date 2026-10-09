import { agent, ndJsonStream, RequestError, type AgentContext } from '@agentclientprotocol/sdk';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { MODELS, SESSION_OPTIONS, type CliModel } from './fixtures/clis/session-options.ts';
import { recordStart } from './started.ts';

const HOUSE = fileURLToPath(new URL('../src/house-main.ts', import.meta.url));
const kind = process.env.ADAPTER_KIND ?? 'codex-acp';
const home = process.env.HOUSE_KIT_HOME ?? '/tmp';
const signedIn = () => existsSync(join(home, 'signed-in', kind));
const executable = process.env.CODEX_PATH ?? process.env.CLAUDE_CODE_EXECUTABLE;
const cli =
  executable === undefined
    ? { path: process.env.CLI_PATH, release: process.env.CLI_RELEASE }
    : {
        path: executable,
        release: /\d+\.\d+\.\d+/.exec(spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout)?.[0],
      };
recordStart('adapter');

function log(entry: Record<string, unknown>): void {
  appendFileSync(join(home, 'adapter.log'), `${JSON.stringify({ kind, pid: process.pid, ...entry })}\n`);
}

if (process.argv.includes('status')) {
  process.exit(signedIn() ? 0 : 1);
}

const offered = join(home, 'models', kind);
const models = existsSync(offered) ? (JSON.parse(readFileSync(offered, 'utf8')) as CliModel[]) : MODELS[kind]!;
let model = models[0]!.id;
let effort = 'medium';
let mode: string | undefined;
const options = () => SESSION_OPTIONS[kind]!(models, model, effort, mode);
const cancelled = new Map<string, () => void>();

const JOB =
  "const clean = require('node:child_process').spawn('sleep', ['600'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } }); process.stdout.write(String(clean.pid)); setInterval(() => undefined, 60_000);";
const LAUNCHER = `const job = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(JOB)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); job.stdout.once('data', (clean) => { process.stdout.write(JSON.stringify({ spawned: job.pid, clean: Number(clean) })); process.exit(0); });`;

function spawnJob(): void {
  log(JSON.parse(spawnSync(process.execPath, ['-e', LAUNCHER], { encoding: 'utf8' }).stdout) as Record<string, unknown>);
}

function ran(entry: Record<string, unknown>, result: SpawnSyncReturns<string>): void {
  log({ ...entry, status: result.status, stdout: result.stdout, stderr: result.stderr });
}

let items = 0;
let apiMessages = 1;
let toolCalls = 0;

function messageSignal(phase: 'commentary' | 'final_answer'): Record<string, unknown> {
  if (kind === 'codex-acp') {
    return { messageId: `item-${phase}-${items}`, _meta: { jetbrains: { air: { phase } } } };
  }
  if (kind === 'claude-agent-acp') return { messageId: `msg_${apiMessages}` };
  return {};
}

async function chunk(client: AgentContext, sessionId: string, text: string, phase: 'commentary' | 'final_answer') {
  await client.notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...messageSignal(phase) },
  });
}

async function say(client: AgentContext, sessionId: string, text: string) {
  await chunk(client, sessionId, text, 'final_answer');
}

async function note(client: AgentContext, sessionId: string, text: string) {
  items++;
  for (const fragment of text.match(/\S+\s*/g) ?? []) await chunk(client, sessionId, fragment, 'commentary');
}

async function tool(client: AgentContext, sessionId: string, title: string) {
  const toolCallId = `call-${++toolCalls}`;
  await client.notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'tool_call', toolCallId, title, kind: 'read', status: 'pending' },
  });
  await client.notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' },
  });
  apiMessages++;
}

async function turnStarted(client: AgentContext, sessionId: string) {
  if (kind === 'grok-build') {
    await client.notify('_x.ai/queue/changed', { sessionId, entries: [], runningPromptId: 'task-completed-1' });
  } else if (kind === 'claude-agent-acp') {
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'tool-later', title: 'Read the job output', status: 'pending' },
    });
  } else {
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'active', activeFlags: [] } } } },
    });
  }
}

async function turnEnded(client: AgentContext, sessionId: string) {
  if (kind === 'grok-build') {
    await client.notify('_x.ai/session_notification', {
      sessionId,
      update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' },
    });
  } else if (kind === 'claude-agent-acp') {
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'usage_update', used: 1, size: 2, _meta: { '_claude/origin': { kind: 'task-notification' } } },
    });
  } else {
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'idle' } } } },
    });
  }
}

async function directive(
  client: AgentContext,
  sessionId: string,
  line: string,
): Promise<'cancelled' | 'answered' | undefined> {
  const [name, ...rest] = line.slice(1).split(' ');
  const argument = rest.join(' ');
  if (name === 'say') await say(client, sessionId, argument.replaceAll('\\n', '\n'));
  if (name === 'version') await say(client, sessionId, `${cli.path} ${cli.release}`);
  if (name === 'note') await note(client, sessionId, argument);
  if (name === 'tool') await tool(client, sessionId, argument);
  if (name === 'think') {
    const messageId =
      kind === 'codex-acp' ? `item-reasoning-${++items}` : kind === 'claude-agent-acp' ? `msg_${apiMessages}` : undefined;
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: argument }, messageId },
    });
  }
  if (name === 'hidden') apiMessages++;
  if (name === 'started') await turnStarted(client, sessionId);
  if (name === 'ended') await turnEnded(client, sessionId);
  if (name === 'fail') throw new RequestError(-32603, argument);
  if (name === 'answer') return 'answered';
  if (name === 'hold') await new Promise((resolve) => setTimeout(resolve, Number(argument)));
  if (name === 'gate') {
    while (!existsSync(join(home, argument))) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (name === 'ping') {
    await client.request('_kit/ping').catch(() => undefined);
    log({ pinged: true });
  }
  if (name === 'exit') process.exit(Number(argument));
  if (name === 'deaf') {
    process.stdin.destroy();
    closeSync(0);
    setInterval(() => undefined, 60_000);
  }
  if (name === 'plan') {
    await client.notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: argument.split('|').map((content) => ({ content, priority: 'medium', status: 'pending' })),
      },
    });
  }
  if (name === 'wait') {
    await new Promise<void>((resolve) => cancelled.set(sessionId, resolve));
    return 'cancelled';
  }
  if (name === 'later') {
    const [delay, ...text] = rest;
    setTimeout(async () => {
      await turnStarted(client, sessionId);
      if (text.length > 0) await say(client, sessionId, text.join(' '));
    }, Number(delay));
    setTimeout(() => void turnEnded(client, sessionId), 2 * Number(delay));
  }
  if (name === 'itself') {
    const [delay, ...script] = rest;
    setTimeout(async () => {
      await turnStarted(client, sessionId);
      for (const step of script.join(' ').split(';')) await directive(client, sessionId, step.trim());
      await turnEnded(client, sessionId);
    }, Number(delay));
  }
  if (name === 'ask') {
    const response = await client.request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'tool-1', title: 'Run a command' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    await say(client, sessionId, JSON.stringify(response));
  }
  if (name === 'abandon') {
    const abandon = new AbortController();
    setTimeout(() => abandon.abort(), Number(argument));
    const outcome = await client
      .request(
        'session/request_permission',
        {
          sessionId,
          toolCall: { toolCallId: 'tool-2', title: 'Run another command' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
        { cancellationSignal: abandon.signal },
      )
      .then(
        () => 'answered',
        () => 'cancelled',
      );
    log({ abandoned: outcome });
  }
  if (name === 'question') {
    const response = await client.request('elicitation/create', {
      sessionId,
      mode: 'form',
      message: 'Which colour?',
      requestedSchema: { type: 'object', properties: { colour: { type: 'string', title: 'Colour' } }, required: ['colour'] },
    });
    await say(client, sessionId, JSON.stringify(response));
  }
  if (name === 'secret') {
    const response = await client.request('elicitation/create', {
      sessionId,
      mode: 'form',
      message: 'Codex needs your input to continue.',
      requestedSchema: {
        type: 'object',
        properties: { token: { type: 'string', title: 'Token', _meta: { codex: { isSecret: true } } } },
        required: ['token'],
      },
    });
    const value = response.action === 'accept' ? String((response.content as Record<string, unknown>).token) : '';
    const matched = createHash('sha256').update(value).digest('hex') === argument;
    await say(client, sessionId, matched ? 'secret matched' : 'secret mismatched');
  }
  if (name === 'commands') {
    await client.notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compact', description: 'Compact the conversation', input: null }],
      },
    });
  }
  if (name === 'config') {
    effort = 'from-cli';
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions: options() },
    });
  }
  if (name === 'job' && kind === 'grok-build') {
    await client.notify('_x.ai/task_backgrounded', {
      sessionId,
      update: { sessionUpdate: 'task_backgrounded', task_id: argument, command: 'sleep 600' },
    });
  } else if (name === 'job') {
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'async_task_spawned', asyncTaskId: argument, name: 'job', taskType: 'shell' },
    } as never);
  }
  if (name === 'jobdone' && kind === 'grok-build') {
    await client.notify('_x.ai/task_completed', {
      sessionId,
      update: { sessionUpdate: 'task_completed', task_snapshot: { task_id: argument, command: 'sleep 600' } },
    });
  } else if (name === 'jobdone') {
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'async_task_state_update', asyncTaskId: argument, state: 'completed' },
    } as never);
  }
  if (name === 'house') {
    const args = rest.length > 1 ? [rest[0]!, rest.slice(1).join(' ')] : rest;
    ran({ house: args }, spawnSync(process.execPath, [HOUSE, ...args], { encoding: 'utf8' }));
  }
  if (name === 'sh') ran({ sh: argument }, spawnSync('sh', ['-c', argument], { encoding: 'utf8' }));
  if (name === 'git') {
    ran({ git: rest }, spawnSync('git', rest, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }));
  }
  if (name === 'spawn') spawnJob();
  return undefined;
}

const app = agent({ name: 'adapter-double' })
  .onRequest('initialize', ({ params }) => {
    log({ method: 'initialize', params, env: process.env, argv: process.argv, cli });
    if (existsSync(join(home, 'refuse-initialize'))) throw new RequestError(-32603, 'the CLI did not initialize');
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      authMethods: [],
      ...(signedIn() ? { _meta: { defaultAuthMethodId: 'device' } } : {}),
    };
  })
  .onRequest('session/new', async ({ params }) => {
    const sessionId = `session-${process.pid}-${Date.now()}`;
    log({ method: 'session/new', params, sessionId });
    if (existsSync(join(home, 'refuse-new'))) throw new RequestError(-32603, 'the session did not open');
    const probeHold = join(home, 'probe-hold');
    if (params.cwd === home && existsSync(probeHold) && readFileSync(probeHold, 'utf8') === models[0]!.id) {
      log({ heldProbe: models[0]!.id });
      while (existsSync(probeHold)) await new Promise((resolve) => setTimeout(resolve, 20));
      log({ releasedProbe: models[0]!.id });
    }
    if (existsSync(join(home, 'hold-open'))) {
      spawnJob();
      await new Promise(() => undefined);
    }
    return { sessionId, configOptions: options() };
  })
  .onRequest('session/resume', ({ params }) => {
    log({ method: 'session/resume', params });
    if (existsSync(join(home, 'refuse-resume'))) {
      throw new RequestError(-32002, 'the session cannot be resumed');
    }
    return { configOptions: options() };
  })
  .onRequest('session/set_config_option', ({ params }) => {
    log({ method: 'session/set_config_option', params });
    const option = options().find((candidate) => candidate.id === params.configId);
    if (option === undefined) throw new RequestError(-32602, `Unknown config option: ${params.configId}`);
    const refused = join(home, 'refuse-model');
    if (option.category === 'model' && existsSync(refused) && readFileSync(refused, 'utf8') === params.value) {
      throw new RequestError(-32603, `Model switch blocked by a PreModelSwitch hook: ${params.value} is not allowed`);
    }
    if (option.category === 'model') model = String(params.value);
    if (option.category === 'thought_level') effort = String(params.value);
    if (option.category === 'mode') mode = String(params.value);
    return { configOptions: options() };
  })
  .onNotification('session/cancel', ({ params }) => {
    log({ method: 'session/cancel', params });
    cancelled.get(params.sessionId)?.();
    cancelled.delete(params.sessionId);
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    log({ method: 'session/prompt', params, text });
    const directives = text.split('\n').filter((line) => line.startsWith('@'));
    for (const line of directives.length === 0 ? ['@say ok'] : directives) {
      const outcome = await directive(client, params.sessionId, line);
      if (outcome === 'answered') return { stopReason: 'end_turn' };
      if (outcome === 'cancelled') {
        await turnEnded(client, params.sessionId);
        return { stopReason: 'cancelled' };
      }
    }
    await turnEnded(client, params.sessionId);
    return { stopReason: 'end_turn' };
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
