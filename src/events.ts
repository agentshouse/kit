import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk';
import type { Marker, PlanStep } from './parts.ts';

type Fields = Record<string, any>;

export interface Message {
  id?: unknown;
  method?: string;
  params?: Fields;
  result?: Fields;
}

export type Event =
  | { kind: 'started' }
  | { kind: 'ended' }
  | { kind: 'text' | 'reasoning'; id: string | null; text: string }
  | { kind: 'command' }
  | { kind: 'subagent'; id: string; description: string }
  | { kind: 'subagent-done'; id: string; result: string | null }
  | { kind: 'message'; command: string; target: string | null }
  | { kind: 'image'; data: string; mediaType: string }
  | { kind: 'marker'; marker: Marker; text: string }
  | { kind: 'plan'; entries: PlanStep[] }
  | { kind: 'context'; used: number; window: number }
  | { kind: 'commands'; commands: AvailableCommand[] }
  | { kind: 'options'; options: SessionConfigOption[] }
  | { kind: 'busy'; key: string; running: boolean }
  | { kind: 'servers' };

type Decision =
  | { shown: 'command' | 'hidden' }
  | { shown: 'message'; command: string; target: string | null }
  | { shown: 'subagent'; description: string }
  | { shown: 'marker'; marker: Marker; text: string };

interface Call {
  id: string;
  decided: Decision | null;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: Fields;
  content?: Fields[];
  meta: Fields;
  imaged: boolean;
}

const COMMAND: Decision = { shown: 'command' };
const HIDDEN: Decision = { shown: 'hidden' };
const FINISHED = new Set(['completed', 'failed']);
const RUNNING_JOB = new Set(['running', 'paused']);
const ROUTINE_TARGETS: Record<string, string> = { send_routine_request: 'access', cancel_routine_request: 'request' };

function words(line: string): string[] {
  const found: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (character === '\\' && quote === '"') word += line[++index] ?? '';
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      word ??= '';
    } else if (character === '\\') {
      word = (word ?? '') + (line[++index] ?? '');
    } else if (/\s/.test(character)) {
      if (word !== null) found.push(word);
      word = null;
    } else {
      word = (word ?? '') + character;
    }
  }
  if (word !== null) found.push(word);
  return found;
}

export function houseMessage(line: string): Decision | null {
  const [program, verb, json] = words(line.trim());
  if (program !== 'house' || verb !== 'run_command' || json === undefined) return null;
  let call: Fields;
  try {
    call = JSON.parse(json) as Fields;
  } catch {
    return null;
  }
  const argument = ROUTINE_TARGETS[call.command];
  if (argument === undefined) return null;
  const target = call.arguments?.[argument];
  return { shown: 'message', command: call.command, target: typeof target === 'string' ? target : null };
}

function decidedByLine(command: unknown, final: boolean): Decision | null {
  const line = typeof command === 'string' ? command : Array.isArray(command) ? command.at(-1) : undefined;
  if (typeof line !== 'string') return final ? COMMAND : null;
  return houseMessage(line) ?? COMMAND;
}

function contentText(content: Fields[] | undefined): string | null {
  const text = (content ?? [])
    .map((entry) => (entry.type === 'content' && entry.content?.type === 'text' ? entry.content.text : ''))
    .filter((part: string) => part !== '')
    .join('\n');
  return text === '' ? null : text;
}

function plan(entries: Fields[]): PlanStep[] {
  return entries.map((entry) => ({ content: entry.content, status: entry.status }));
}

function merged(into: Fields, from: Fields | null | undefined): Fields {
  if (from === null || from === undefined) return into;
  const result: Fields = { ...into };
  for (const [key, value] of Object.entries(from)) {
    result[key] =
      typeof value === 'object' && value !== null && !Array.isArray(value) && typeof into[key] === 'object'
        ? merged(into[key] as Fields, value as Fields)
        : value;
  }
  return result;
}

function names(input: Fields | undefined, ids: Iterable<string>): boolean {
  const values = JSON.stringify(input ?? {});
  for (const id of ids) if (values.includes(id)) return true;
  return false;
}

abstract class Reader {
  session: string | null = null;
  protected readonly calls = new Map<string, Call>();
  protected readonly subagents = new Set<string>();
  protected readonly done = new Set<string>();
  private readonly seenOptions = new Map<string, unknown>();
  private readonly requestedOptions = new Map<string, unknown>();
  private readonly compactions = new Set<string>();
  private readonly jobs = new Map<string, string>();
  protected abstract readonly watchedOptions: Record<string, Marker>;

  read(message: Message): Event[] {
    if (message.method === undefined) return this.answered(message.result);
    const session = message.params?.sessionId as string | undefined;
    if (session !== undefined && this.session !== null && session !== this.session) {
      return this.elsewhere(session, message);
    }
    return this.own(message);
  }

  requested(option: string, value: unknown): void {
    this.requestedOptions.set(option, value);
  }

  refused(option: string): void {
    this.requestedOptions.delete(option);
  }

  turnStarted(): Event[] {
    return [];
  }

  closeTurn(): Event[] {
    const events: Event[] = [];
    for (const [id, call] of this.calls) {
      if (call.decided?.shown === 'subagent') continue;
      if (call.decided === null) events.push(...this.shown(call, this.decide(call, true)!));
      this.calls.delete(id);
    }
    return events;
  }

  protected answered(result: Fields | undefined): Event[] {
    if (typeof result?.sessionId === 'string' && this.session === null) this.session = result.sessionId;
    for (const option of (result?.configOptions ?? []) as Fields[]) {
      this.seenOptions.set(option.id, option.currentValue);
      this.requestedOptions.delete(option.id);
    }
    return [];
  }

  protected elsewhere(_session: string, _message: Message): Event[] {
    return [];
  }

  protected own(message: Message): Event[] {
    if (message.method !== 'session/update') return this.extension(message);
    return this.update(message.params!.update as Fields);
  }

  protected extension(_message: Message): Event[] {
    return [];
  }

  protected update(update: Fields): Event[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'image') return [{ kind: 'image', data: update.content.data, mediaType: update.content.mimeType }];
        return update.content.type === 'text' ? [{ kind: 'text', id: update.messageId ?? null, text: update.content.text }] : [];
      case 'agent_thought_chunk':
        return update.content.type === 'text' ? [{ kind: 'reasoning', id: update.messageId ?? null, text: update.content.text }] : [];
      case 'tool_call':
      case 'tool_call_update':
        return this.tool(update);
      case 'plan':
        return [{ kind: 'plan', entries: plan(update.entries) }];
      case 'usage_update':
        return [{ kind: 'context', used: update.used, window: update.size }];
      case 'current_mode_update':
        return [{ kind: 'marker', marker: 'mode', text: update.currentModeId }];
      case 'available_commands_update':
        return [{ kind: 'commands', commands: update.availableCommands }];
      case 'config_option_update':
        return [{ kind: 'options', options: update.configOptions }, ...this.optionsChanged(update.configOptions)];
      case 'compaction_update':
        if (update.status !== 'completed' || this.compactions.has(update.compactionId)) return [];
        this.compactions.add(update.compactionId);
        return [{ kind: 'marker', marker: 'compaction', text: '' }];
      case 'async_task_spawned':
        return this.job(update.asyncTaskId, update.name ?? update.description ?? '', 'running');
      case 'async_task_state_update':
        return RUNNING_JOB.has(update.state) ? [] : this.job(update.asyncTaskId, null, update.state);
      default:
        return [];
    }
  }

  protected job(id: string, name: string | null, state: string): Event[] {
    if (name !== null) this.jobs.set(id, name);
    const label = this.jobs.get(id) ?? '';
    if (state !== 'running') this.jobs.delete(id);
    return [
      { kind: 'busy', key: `job:${id}`, running: state === 'running' },
      { kind: 'marker', marker: 'job', text: `${label}: ${state}` },
    ];
  }

  private optionsChanged(options: Fields[]): Event[] {
    const events: Event[] = [];
    for (const option of options) {
      const marker = this.watchedOptions[option.id];
      const before = this.seenOptions.get(option.id);
      this.seenOptions.set(option.id, option.currentValue);
      if (marker === undefined || before === undefined || before === option.currentValue) continue;
      if (this.requestedOptions.get(option.id) === option.currentValue) {
        this.requestedOptions.delete(option.id);
        continue;
      }
      events.push({ kind: 'marker', marker, text: String(option.currentValue) });
    }
    return events;
  }

  protected tool(update: Fields): Event[] {
    let call = this.calls.get(update.toolCallId);
    if (call === undefined) {
      if (update.sessionUpdate !== 'tool_call') return [];
      call = { id: update.toolCallId, decided: null, meta: {}, imaged: false, status: 'in_progress' };
      this.calls.set(call.id, call);
    }
    if (update.kind !== undefined) call.kind = update.kind;
    if (update.title !== undefined) call.title = update.title;
    if (update.status !== undefined) call.status = update.status;
    if (update.rawInput !== undefined) call.rawInput = merged(call.rawInput ?? {}, update.rawInput as Fields);
    if (update.content !== undefined) call.content = update.content;
    call.meta = merged(call.meta, update._meta as Fields);
    const events: Event[] = [];
    const finished = FINISHED.has(call.status!);
    if (call.decided === null) {
      const decided = this.decide(call, finished);
      if (decided !== null) events.push(...this.shown(call, decided));
    }
    events.push(...this.produced(call));
    if (call.decided?.shown === 'subagent' && finished) events.push(...this.subagentFinished(call));
    else if (finished) this.calls.delete(call.id);
    return events;
  }

  protected shown(call: Call, decided: Decision): Event[] {
    call.decided = decided;
    switch (decided.shown) {
      case 'command':
        return [{ kind: 'command' }];
      case 'hidden':
        return [];
      case 'message':
        return [{ kind: 'message', command: decided.command, target: decided.target }];
      case 'marker':
        return [{ kind: 'marker', marker: decided.marker, text: decided.text }];
      case 'subagent':
        this.subagents.add(call.id);
        return [{ kind: 'subagent', id: call.id, description: decided.description }];
    }
  }

  protected produced(_call: Call): Event[] {
    return [];
  }

  protected subagentFinished(call: Call): Event[] {
    this.calls.delete(call.id);
    return this.finish(call.id, contentText(call.content));
  }

  protected finish(id: string, result: string | null): Event[] {
    if (!this.subagents.has(id) || this.done.has(id)) return [];
    this.done.add(id);
    this.calls.delete(id);
    return [{ kind: 'subagent-done', id, result }];
  }

  protected abstract decide(call: Call, final: boolean): Decision | null;
}

class ClaudeReader extends Reader {
  protected override readonly watchedOptions: Record<string, Marker> = { model: 'model' };
  private readonly tasks = new Map<string, string>();
  private readonly scheduled = new Map<string, { recurring: boolean; text: string }>();

  protected override own(message: Message): Event[] {
    if (message.params?.update?._meta?.claudeCode?.parentToolUseId !== undefined) return [];
    return super.own(message);
  }

  protected override update(update: Fields): Event[] {
    if (update.sessionUpdate === 'usage_update' && update._meta?.['_claude/origin'] !== undefined) {
      return [...super.update(update), { kind: 'ended' }];
    }
    if (update.sessionUpdate === 'session_info_update' && update._meta?.jetbrains?.air?.sessionFailure !== undefined) {
      return [{ kind: 'marker', marker: 'retry', text: update._meta.jetbrains.air.sessionFailure.title }];
    }
    return super.update(update);
  }

  protected override extension(message: Message): Event[] {
    if (message.method !== '_claude/sdkMessage') return [];
    const sdk = message.params!.message as Fields;
    switch (sdk.subtype) {
      case 'background_tasks_changed':
        return [{ kind: 'busy', key: 'tasks', running: sdk.tasks.length > 0 }];
      case 'session_state_changed':
        return [{ kind: 'busy', key: 'state', running: sdk.state === 'running' }];
      case 'task_started':
        if (sdk.tool_use_id !== undefined) this.tasks.set(sdk.task_id, sdk.tool_use_id);
        return [];
      case 'task_notification':
        return sdk.tool_use_id === undefined ? [] : this.finish(sdk.tool_use_id, sdk.summary ?? null);
      default:
        return [];
    }
  }

  override turnStarted(): Event[] {
    const events: Event[] = [];
    for (const [id, entry] of this.scheduled) {
      if (entry.recurring) continue;
      this.scheduled.delete(id);
      events.push({ kind: 'busy', key: `scheduled:${id}`, running: false });
    }
    return events;
  }

  protected override decide(call: Call, final: boolean): Decision | null {
    const tool = call.meta.claudeCode?.toolName as string | undefined;
    if (tool === 'Agent' || tool === 'Task' || call.meta.jetbrains?.air?.subagent === true) {
      const description = call.rawInput?.description as string | undefined;
      if (description === undefined && !final) return null;
      return { shown: 'subagent', description: description ?? call.title ?? '' };
    }
    if (tool === 'TodoWrite' || tool === 'CronCreate') return HIDDEN;
    if (tool === 'ScheduleWakeup') {
      if (call.rawInput === undefined) return final ? COMMAND : null;
      return call.rawInput.stop === true ? COMMAND : HIDDEN;
    }
    if (call.kind === 'switch_mode') return { shown: 'marker', marker: 'mode', text: call.title ?? '' };
    if (tool === 'Bash') return decidedByLine(call.rawInput?.command, final);
    if (tool === 'SendMessage' || tool === 'TaskStop') {
      if (call.rawInput === undefined) return final ? COMMAND : null;
      return names(call.rawInput, this.tasks.keys()) ? HIDDEN : COMMAND;
    }
    return COMMAND;
  }

  protected override produced(call: Call): Event[] {
    const tool = call.meta.claudeCode?.toolName as string | undefined;
    if (call.status !== 'completed') return [];
    if (tool === 'CronCreate' || (tool === 'ScheduleWakeup' && call.rawInput?.stop !== true)) {
      this.scheduled.set(call.id, {
        recurring: tool === 'CronCreate' && call.rawInput?.recurring !== false,
        text: contentText(call.content) ?? '',
      });
      return [
        { kind: 'busy', key: `scheduled:${call.id}`, running: true },
        { kind: 'marker', marker: 'job', text: `${call.rawInput?.prompt ?? call.title ?? ''}: scheduled` },
      ];
    }
    if (tool === 'CronDelete') {
      for (const [id, entry] of this.scheduled) {
        if (!entry.text.includes(String(call.rawInput?.id))) continue;
        this.scheduled.delete(id);
        return [{ kind: 'busy', key: `scheduled:${id}`, running: false }];
      }
    }
    return [];
  }

  protected override subagentFinished(call: Call): Event[] {
    if (call.meta.claudeCode?.toolResponse?.isAsync === true) return [];
    return super.subagentFinished(call);
  }
}

const COLLABORATION = new Set(['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent', 'followupTask']);

class CodexReader extends Reader {
  protected override readonly watchedOptions: Record<string, Marker> = { mode: 'mode', collaboration_mode: 'mode' };
  private readonly children = new Map<string, { id: string | null; text: string }>();

  protected override own(message: Message): Event[] {
    if (message.method === 'session/request_permission' && message.params!.toolCall?.kind === 'switch_mode') {
      return [{ kind: 'started' }, { kind: 'marker', marker: 'mode', text: message.params!.toolCall.title ?? '' }];
    }
    return super.own(message);
  }

  protected override update(update: Fields): Event[] {
    switch (update.sessionUpdate) {
      case 'session_info_update': {
        const codex = update._meta?.codex as Fields | undefined;
        if (codex?.threadStatus?.type === 'active') return [{ kind: 'started' }];
        if (codex?.threadStatus?.type === 'idle') return [{ kind: 'ended' }];
        if (codex?.error !== undefined) return [{ kind: 'marker', marker: 'retry', text: codex.error.message ?? '' }];
        return [];
      }
      case 'notice':
        return update.severity === 'info' ? [{ kind: 'marker', marker: 'model', text: update.description ?? update.title }] : [];
      case 'subagent_spawned':
        this.children.set(update.subagentSessionId, { id: null, text: '' });
        this.subagents.add(update.subagentSessionId);
        return [
          { kind: 'busy', key: `subagent:${update.subagentSessionId}`, running: true },
          { kind: 'subagent', id: update.subagentSessionId, description: update.name },
        ];
      case 'subagent_state_update':
        return [
          { kind: 'busy', key: `subagent:${update.subagentSessionId}`, running: false },
          ...this.finish(update.subagentSessionId, this.children.get(update.subagentSessionId)?.text || null),
        ];
      default:
        return super.update(update);
    }
  }

  protected override elsewhere(session: string, message: Message): Event[] {
    const child = this.children.get(session);
    const update = message.params?.update as Fields | undefined;
    if (child === undefined || update === undefined) return [];
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      const id = update.messageId ?? null;
      if (child.id !== id) child.text = '';
      child.id = id;
      child.text += update.content.text;
    }
    const status = update._meta?.codex?.threadStatus?.type as string | undefined;
    if (update.sessionUpdate === 'session_info_update' && status !== undefined) {
      return [{ kind: 'busy', key: `thread:${session}`, running: status === 'active' }];
    }
    return [];
  }

  protected override decide(call: Call): Decision | null {
    const air = call.meta.jetbrains?.air as Fields | undefined;
    if (COLLABORATION.has(call.title ?? '')) return HIDDEN;
    if (air?.subagent !== undefined) return { shown: 'subagent', description: call.title ?? '' };
    if (call.kind === 'switch_mode') return { shown: 'marker', marker: 'mode', text: call.title ?? '' };
    if (call.kind === 'execute') return decidedByLine(call.rawInput?.command, true);
    if (call.title === 'Image generation') return HIDDEN;
    return COMMAND;
  }

  protected override produced(call: Call): Event[] {
    if (call.imaged || call.kind === 'read') return [];
    const image = (call.content ?? []).find((entry) => entry.type === 'content' && entry.content?.type === 'image');
    if (image === undefined) return [];
    call.imaged = true;
    return [{ kind: 'image', data: image.content.data, mediaType: image.content.mimeType }];
  }
}

class GrokReader extends Reader {
  protected override readonly watchedOptions: Record<string, Marker> = {};
  private readonly children = new Map<string, string | null>();
  private readonly queues = new Map<string, { running: string | null; entries: number }>();
  private models: Fields[] = [];
  private model: string | null = null;

  protected override answered(result: Fields | undefined): Event[] {
    if (result?.models !== undefined) this.offered(result.models);
    return super.answered(result);
  }

  override read(message: Message): Event[] {
    const session = message.params?.sessionId as string;
    if (this.session !== null && session !== undefined && session !== this.session && !this.children.has(session)) return [];
    if (message.method === '_x.ai/queue/changed') {
      const running = message.params!.runningPromptId ?? null;
      this.queues.set(session, { running, entries: message.params!.entries.length });
      return [this.queued(session), ...(running !== null && session === this.session ? [{ kind: 'started' as const }] : [])];
    }
    if (message.params?.update?.sessionUpdate === 'turn_completed') {
      const queue = this.queues.get(session);
      if (queue !== undefined && queue.running === message.params.update.prompt_id) queue.running = null;
      return [this.queued(session), ...(session === this.session ? [{ kind: 'ended' as const }] : [])];
    }
    if (message.method === '_x.ai/models/update') {
      this.offered(message.params!);
      return [];
    }
    return super.read(message);
  }

  private queued(session: string): Event {
    const queue = this.queues.get(session);
    return { kind: 'busy', key: `queue:${session}`, running: queue !== undefined && (queue.running !== null || queue.entries > 0) };
  }

  private offered(models: Fields): void {
    this.models = models.availableModels ?? this.models;
    this.model = models.currentModelId ?? this.model;
  }

  private window(): number | null {
    return this.models.find((model) => model.modelId === this.model)?._meta?.totalContextTokens ?? null;
  }

  protected override extension(message: Message): Event[] {
    const update = message.params?.update as Fields | undefined;
    switch (message.method) {
      case '_x.ai/task_backgrounded':
        return this.job(update!.task_id, update!.description ?? update!.command ?? '', 'running');
      case '_x.ai/task_completed':
        return this.job(update!.task_snapshot.task_id, null, update!.task_snapshot.exit_code === 0 ? 'completed' : 'failed');
      case '_x.ai/scheduled_task_created':
        return [
          { kind: 'busy', key: `scheduled:${update!.task_id}`, running: true },
          { kind: 'marker', marker: 'job', text: `${update!.prompt}: next run ${update!.next_fire_at}` },
        ];
      case '_x.ai/scheduled_task_deleted':
        return [{ kind: 'busy', key: `scheduled:${update!.task_id}`, running: false }];
      case '_x.ai/session_notification':
        return this.notification(update!);
      case '_x.ai/mcp_initialized':
        return [{ kind: 'servers' }];
      default:
        return [];
    }
  }

  private notification(update: Fields): Event[] {
    switch (update.sessionUpdate) {
      case 'response_completed': {
        const usage = update.usage as Fields;
        const window = this.window();
        if (window === null) return [];
        const used =
          usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + usage.output_tokens;
        return [{ kind: 'context', used, window }];
      }
      case 'subagent_spawned': {
        const call =
          [...this.calls.values()].find(
            (candidate) =>
              candidate.decided?.shown === 'subagent' &&
              ![...this.children.values()].includes(candidate.id) &&
              candidate.decided.description === update.description,
          ) ??
          [...this.calls.values()].find(
            (candidate) => candidate.decided?.shown === 'subagent' && ![...this.children.values()].includes(candidate.id),
          );
        this.children.set(update.child_session_id, call?.id ?? null);
        return [{ kind: 'busy', key: `subagent:${update.child_session_id}`, running: true }];
      }
      case 'subagent_finished': {
        const call = this.children.get(update.child_session_id);
        return [
          { kind: 'busy', key: `subagent:${update.child_session_id}`, running: false },
          ...(typeof call === 'string' ? this.finish(call, update.output ?? null) : []),
        ];
      }
      case 'auto_compact_completed':
        return [{ kind: 'marker', marker: 'compaction', text: '' }];
      case 'model_auto_switched':
        this.model = update.new_model_id;
        return [{ kind: 'marker', marker: 'model', text: update.new_model_id }];
      case 'retry_state':
        return [{ kind: 'marker', marker: 'retry', text: update.message ?? update.reason ?? update.error_type ?? '' }];
      default:
        return [];
    }
  }

  protected override decide(call: Call): Decision | null {
    const tool = (call.meta['x.ai/tool'] ?? {}) as Fields;
    if (tool.name === 'spawn_subagent' || tool.kind === 'task') {
      return { shown: 'subagent', description: call.rawInput?.description ?? call.title ?? '' };
    }
    if (tool.name === 'todo_write' || tool.name === 'scheduler_create') return HIDDEN;
    if (tool.name === 'enter_plan_mode' || tool.name === 'exit_plan_mode') {
      return { shown: 'marker', marker: 'mode', text: tool.name };
    }
    if (tool.name === 'kill_command_or_subagent') return names(call.rawInput, this.children.keys()) ? HIDDEN : COMMAND;
    if (tool.name === 'run_terminal_command') return decidedByLine(call.rawInput?.command, true);
    return COMMAND;
  }

  protected override subagentFinished(_call: Call): Event[] {
    return [];
  }
}

export type { Reader };

export function readerFor(kind: string): Reader {
  if (kind === 'claude-agent-acp') return new ClaudeReader();
  if (kind === 'grok-build') return new GrokReader();
  return new CodexReader();
}
