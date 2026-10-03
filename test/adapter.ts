import { agent, ndJsonStream, RequestError, type AgentContext, type SessionConfigOption } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

const kind = process.env.ADAPTER_KIND ?? 'codex-acp';
const home = process.env.HOUSE_KIT_HOME ?? '/tmp';
const signedIn = () => existsSync(join(home, 'signed-in', kind));

function log(entry: Record<string, unknown>): void {
  appendFileSync(join(home, 'adapter.log'), `${JSON.stringify({ kind, pid: process.pid, ...entry })}\n`);
}

if (process.argv.includes('status')) {
  process.exit(signedIn() ? 0 : 1);
}

const options = (model: string, effort: string): SessionConfigOption[] => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort, options: [] },
];
let model = 'default-model';
let effort = 'default-effort';
const cancelled = new Map<string, () => void>();

async function say(client: AgentContext, sessionId: string, text: string) {
  await client.notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
}

async function directive(client: AgentContext, sessionId: string, line: string): Promise<'cancelled' | undefined> {
  const [name, ...rest] = line.slice(1).split(' ');
  const argument = rest.join(' ');
  if (name === 'say') await say(client, sessionId, argument.replaceAll('\\n', '\n'));
  if (name === 'hold') await new Promise((resolve) => setTimeout(resolve, Number(argument)));
  if (name === 'exit') process.exit(Number(argument));
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
    setTimeout(() => void say(client, sessionId, text.join(' ')), Number(delay));
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
      update: { sessionUpdate: 'config_option_update', configOptions: options(model, effort) },
    });
  }
  if (name === 'job') {
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'async_task_spawned', asyncTaskId: argument, name: 'job', taskType: 'shell' },
    } as never);
  }
  if (name === 'jobdone') {
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'async_task_state_update', asyncTaskId: argument, state: 'completed' },
    } as never);
  }
  if (name === 'spawn') {
    const child = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
    log({ spawned: child.pid });
  }
  return undefined;
}

const app = agent({ name: 'adapter-double' })
  .onRequest('initialize', ({ params }) => {
    log({ method: 'initialize', params });
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      authMethods: [],
      ...(signedIn() ? { _meta: { defaultAuthMethodId: 'device' } } : {}),
    };
  })
  .onRequest('session/new', ({ params }) => {
    const sessionId = `session-${process.pid}-${Date.now()}`;
    log({ method: 'session/new', params, sessionId });
    return { sessionId, configOptions: options(model, effort) };
  })
  .onRequest('session/resume', ({ params }) => {
    log({ method: 'session/resume', params });
    if (existsSync(join(home, 'refuse-resume'))) {
      throw new RequestError(-32002, 'the session cannot be resumed');
    }
    return { configOptions: options(model, effort) };
  })
  .onRequest('session/set_config_option', ({ params }) => {
    log({ method: 'session/set_config_option', params });
    if (params.configId === 'model') model = String(params.value);
    if (params.configId === 'effort') effort = String(params.value);
    return { configOptions: options(model, effort) };
  })
  .onNotification('session/cancel', ({ params }) => {
    log({ method: 'session/cancel', params });
    cancelled.get(params.sessionId)?.();
    cancelled.delete(params.sessionId);
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
    log({ method: 'session/prompt', params, text });
    const directives = text.split('\n').filter((line) => line.startsWith('@'));
    for (const line of directives.length === 0 ? ['@say ok'] : directives) {
      if ((await directive(client, params.sessionId, line)) === 'cancelled') return { stopReason: 'cancelled' };
    }
    return { stopReason: 'end_turn' };
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
