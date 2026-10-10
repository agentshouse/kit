import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { RUNNING_JOB, type Message } from './events.ts';
import { kitHome } from './home.ts';

type Fields = Record<string, any>;

const ENDED_TASK = new Set(['completed', 'failed', 'killed']);
const SCHEDULING = new Set(['CronCreate', 'CronDelete', 'ScheduleWakeup']);
const QUEUE_LIST = 'house-kit-queue-';
const SYNC = 'house-kit-sync-';
const WAKEUP = /Next wakeup scheduled for (\d\d):(\d\d):(\d\d) \(in (\d+)s\)/;
const HALF_DAY = 12 * 60 * 60 * 1000;

export function codexLauncher(): string {
  return join(kitHome(), 'launchers', 'codex');
}

export class Work {
  protected readonly changed: () => void;
  private readonly jobs = new Set<string>();

  constructor(changed: () => void) {
    this.changed = changed;
  }

  async open(_cli: string): Promise<Record<string, string>> {
    return {};
  }

  async settled(): Promise<void> {}

  read(message: Message): void {
    this.take(message);
    this.changed();
  }

  protected take(message: Message): void {
    const update = message.params?.update as Fields | undefined;
    if (message.method !== 'session/update' || update?.asyncTaskId === undefined) return;
    if (update.sessionUpdate === 'async_task_spawned') this.jobs.add(update.asyncTaskId);
    if (update.sessionUpdate === 'async_task_state_update' && !RUNNING_JOB.has(update.state)) this.jobs.delete(update.asyncTaskId);
  }

  busy(): boolean {
    return this.jobs.size > 0;
  }

  close(): void {}
}

class ClaudeWork extends Work {
  private readonly cwd: string;
  private level = new Set<string>();
  private readonly listed = new Set<string>();
  private readonly started = new Set<string>();
  private running = false;
  private readonly hooks = new Set<string>();
  private readonly calls = new Map<string, Fields>();
  private readonly crons = new Map<string, string>();
  private wakeups: number[] = [];
  private goal = false;

  constructor(cwd: string, changed: () => void) {
    super(changed);
    this.cwd = cwd;
  }

  protected override take(message: Message): void {
    super.take(message);
    if (message.method === '_claude/sdkMessage') this.sdk(message.params!.message as Fields);
    if (message.method === 'session/update') this.update(message.params!.update as Fields);
  }

  override busy(): boolean {
    return (
      super.busy() ||
      this.level.size > 0 ||
      this.started.size > 0 ||
      this.running ||
      this.hooks.size > 0 ||
      this.crons.size > 0 ||
      this.wakeups.length > 0 ||
      this.goal ||
      this.durable()
    );
  }

  private sdk(message: Fields): void {
    switch (message.subtype) {
      case 'background_tasks_changed':
        this.level = new Set((message.tasks as Fields[]).map((task) => task.task_id as string));
        for (const id of this.level) {
          this.listed.add(id);
          this.started.delete(id);
        }
        break;
      case 'task_started':
        if (!this.listed.has(message.task_id)) this.started.add(message.task_id);
        break;
      case 'task_updated':
        if (ENDED_TASK.has(message.patch.status)) this.started.delete(message.task_id);
        break;
      case 'task_notification':
        this.started.delete(message.task_id);
        break;
      case 'session_state_changed':
        if (message.state === 'running' && !this.running) this.wakeups = this.wakeups.filter((due) => due > Date.now());
        this.running = message.state === 'running';
        break;
      case 'hook_started':
        this.hooks.add(message.hook_id);
        break;
      case 'hook_response':
        this.hooks.delete(message.hook_id);
        break;
    }
  }

  private update(update: Fields): void {
    const air = update._meta?.jetbrains?.air as Fields | undefined;
    if (update.sessionUpdate === 'session_info_update' && air !== undefined && 'goal' in air) {
      this.goal = air.goal?.status === 'active';
    }
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    const tool = update._meta?.claudeCode?.toolName as string | undefined;
    if (update.sessionUpdate === 'tool_call' && SCHEDULING.has(tool ?? '')) this.calls.set(update.toolCallId, { tool });
    const call = this.calls.get(update.toolCallId);
    if (call === undefined) return;
    if (update.rawInput !== undefined) call.input = update.rawInput;
    if (update.content !== undefined) call.content = update.content;
    if (update.status === 'failed') this.calls.delete(update.toolCallId);
    if (update.status !== 'completed') return;
    this.calls.delete(update.toolCallId);
    if (call.tool === 'CronCreate') this.crons.set(update.toolCallId, JSON.stringify(call.content ?? []));
    if (call.tool === 'ScheduleWakeup') this.wakeup(call);
    if (call.tool !== 'CronDelete') return;
    for (const [id, text] of this.crons) if (text.includes(String(call.input?.id))) this.crons.delete(id);
  }

  private wakeup(call: Fields): void {
    if (call.input?.stop === true) {
      this.wakeups = [];
      return;
    }
    const time = WAKEUP.exec(JSON.stringify(call.content ?? []));
    if (time === null) {
      this.wakeups.push(Infinity);
      return;
    }
    const fires = Date.now() + Number(time[4]) * 1000;
    const due = new Date(fires);
    due.setHours(Number(time[1]), Number(time[2]), Number(time[3]), 0);
    if (due.getTime() - fires > HALF_DAY) due.setDate(due.getDate() - 1);
    if (fires - due.getTime() > HALF_DAY) due.setDate(due.getDate() + 1);
    this.wakeups.push(due.getTime());
  }

  private durable(): boolean {
    let text: string;
    try {
      text = readFileSync(join(this.cwd, '.claude', 'scheduled_tasks.json'), 'utf8');
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
    try {
      return (JSON.parse(text) as { tasks?: unknown[] }).tasks?.length !== 0;
    } catch {
      return true;
    }
  }
}

class CodexWork extends Work {
  private readonly threads = new Map<string, boolean>();
  private readonly queues = new Map<string, number>();
  private readonly goals = new Set<string>();
  private readonly items = new Set<string>();
  private readonly hooks = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly settling: (() => void)[] = [];
  private memories: boolean | null = null;
  private lost = false;
  private server: Server | null = null;
  private path: string | null = null;
  private socket: Socket | null = null;
  private asked = 0;
  private heard = 0;
  private proving = -1;
  private proven = -1;

  override async open(cli: string): Promise<Record<string, string>> {
    const sockets = join(kitHome(), 'bridges');
    await mkdir(sockets, { recursive: true, mode: 0o700 });
    this.path = join(sockets, `${randomUUID()}.sock`);
    this.server = createServer((socket) => this.connected(socket));
    this.server.listen(this.path);
    await once(this.server, 'listening');
    return { CODEX_PATH: codexLauncher(), HOUSE_KIT_CODEX: cli, HOUSE_KIT_CODEX_STREAM: this.path };
  }

  override settled(): Promise<void> {
    return new Promise((resolve) => {
      this.settling.push(resolve);
      this.settle();
    });
  }

  protected override take(message: Message): void {
    super.take(message);
    this.heard++;
  }

  override busy(): boolean {
    if (
      super.busy() ||
      this.lost ||
      this.memories !== false ||
      [...this.threads.values()].some(Boolean) ||
      this.queues.size > 0 ||
      this.goals.size > 0 ||
      this.items.size > 0 ||
      this.hooks.size > 0
    ) {
      return true;
    }
    if (this.proven === this.heard) return false;
    this.prove();
    return true;
  }

  override close(): void {
    this.server?.close();
    if (this.path !== null) void rm(this.path, { force: true });
  }

  private connected(socket: Socket): void {
    this.socket = socket;
    let buffer = '';
    socket.on('error', () => this.lose());
    socket.on('close', () => this.lose());
    socket.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const message = this.parsed(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (message !== null) this.stream(message, socket);
      }
      this.settle();
      this.changed();
    });
  }

  private parsed(line: string): Message | null {
    try {
      return JSON.parse(line) as Message;
    } catch {
      this.lost = true;
      return null;
    }
  }

  private lose(): void {
    this.lost = true;
    this.changed();
  }

  private prove(): void {
    if (this.proving === this.heard) return;
    this.proving = this.heard;
    this.socket!.write(`${JSON.stringify({ jsonrpc: '2.0', id: `${SYNC}${this.heard}`, method: 'house-kit/sync' })}\n`);
  }

  private settle(): void {
    if (this.starting.size === 0) for (const resolve of this.settling.splice(0)) resolve();
  }

  private stream(message: Message, socket: Socket): void {
    const params = message.params as Fields;
    switch (message.method) {
      case 'thread/status/changed':
        this.threads.set(params.threadId, params.status.type === 'active' && params.status.activeFlags.length === 0);
        break;
      case 'thread/closed':
        this.threads.delete(params.threadId);
        break;
      case 'thread/queue/changed':
        this.queues.set(params.threadId, ++this.asked);
        socket.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: `${QUEUE_LIST}${this.asked}`, method: 'thread/queue/list', params: { threadId: params.threadId } })}\n`,
        );
        break;
      case 'thread/goal/updated':
        if (params.goal.status === 'active') this.goals.add(params.threadId);
        else this.goals.delete(params.threadId);
        break;
      case 'thread/goal/cleared':
        this.goals.delete(params.threadId);
        break;
      case 'item/started':
        this.items.add(`${params.threadId} ${params.item.id}`);
        break;
      case 'item/completed':
        this.items.delete(`${params.threadId} ${params.item.id}`);
        break;
      case 'hook/started':
        this.hooks.add(params.run.id);
        break;
      case 'hook/completed':
        this.hooks.delete(params.run.id);
        break;
      case 'mcpServer/startupStatus/updated':
        if (params.status === 'starting') this.starting.add(`${params.threadId} ${params.name}`);
        else this.starting.delete(`${params.threadId} ${params.name}`);
        break;
      case undefined:
        this.answered(message);
    }
  }

  private answered(message: Message): void {
    if (typeof message.id === 'string' && message.id.startsWith(SYNC)) {
      this.proven = Number(message.id.slice(SYNC.length));
    } else if (typeof message.id === 'string' && message.id.startsWith(QUEUE_LIST)) {
      const asked = Number(message.id.slice(QUEUE_LIST.length));
      for (const [thread, latest] of this.queues) {
        if (latest === asked && message.result?.data?.length === 0) this.queues.delete(thread);
      }
    } else if (message.result?.config?.features !== undefined) {
      this.memories = message.result.config.features.memories !== false;
    }
  }
}

class GrokWork extends Work {
  override busy(): boolean {
    return true;
  }
}

export function workFor(kind: string, cwd: string, changed: () => void): Work {
  if (kind === 'claude-agent-acp') return new ClaudeWork(cwd, changed);
  if (kind === 'codex-acp') return new CodexWork(changed);
  return new GrokWork(changed);
}
