import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk';
import type { PartOf, SessionState, Tokens } from '@agentshouse/session-content';
import type { Called, FileLines, Kind } from './content.ts';

type Fields = Record<string, any>;

export interface Message {
  id?: unknown;
  method?: string;
  params?: Fields;
  result?: Fields;
}

export type Stop = 'end_turn' | 'refusal';

export type NoticeKind = PartOf<'notice'>['kind'];

type Status = 'running' | 'done' | 'failed' | 'stopped';

type Running = SessionState['running'][number]['kind'];

type Files = SessionState['files'];

type Limit = SessionState['limits'][number];

export interface CallEvent {
  kind: 'call';
  key: string;
  parent: string | null;
  first: boolean;
  call: Called;
  running: boolean | null;
}

export type Event =
  | { kind: 'started' }
  | { kind: 'ended'; stop: Stop | null }
  | { kind: 'text'; id: string | null; text: string }
  | CallEvent
  | { kind: 'notice'; notice: NoticeKind; text: string }
  | { kind: 'image'; data: string; mediaType: string }
  | { kind: 'state'; state: Partial<SessionState> }
  | { kind: 'tokens'; tokens: Tokens }
  | { kind: 'commands'; commands: AvailableCommand[] }
  | { kind: 'options'; options: SessionConfigOption[] };

type Counting = Kind | 'subagent' | 'plan';

interface Call {
  id: string;
  parent: string | null;
  counted: Counting | null;
  kind?: string;
  title?: string;
  status: string;
  rawInput?: Fields;
  rawOutput?: any;
  content?: Fields[];
  meta: Fields;
  imaged: boolean;
}

const AUTONOMOUS_ORIGINS = new Set(['task-notification', 'peer', 'coordinator', 'observer', 'observer-activity']);

const FINISHED = new Set(['completed', 'failed', 'stopped']);
export const RUNNING_JOB = new Set(['running', 'paused']);
const ENDED: Record<string, Status> = { completed: 'done', failed: 'failed', stopped: 'stopped', killed: 'stopped', cancelled: 'stopped' };
const NOTICES: Record<string, NoticeKind> = { info: 'info', warning: 'warning', error: 'error' };
// Claude Code names its limit windows without their length, so the Kit holds the length each name stands for.
const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10_080 };
const WAKEUP = /Next wakeup scheduled for \d\d:\d\d:\d\d \(in (\d+)s\)/;
const CHILD_UPDATES = new Set(['tool_call', 'tool_call_update']);

function counted(reports: Tokens[]): Event[] {
  const whole = reports.every((tokens) => Object.values(tokens).every((count) => Number.isSafeInteger(count) && count >= 0));
  return whole ? reports.map((tokens) => ({ kind: 'tokens', tokens })) : [];
}

function contentText(content: Fields[] | undefined): string {
  return (content ?? [])
    .map((entry) => (entry.type === 'content' && entry.content?.type === 'text' ? entry.content.text : ''))
    .filter((part: string) => part !== '')
    .join('\n');
}

function linesOf(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function instant(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function changeCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

function wholeFile(path: string, sign: '+' | '-', text: string): FileLines {
  const lines = linesOf(text).length;
  return sign === '+' ? { path, added: lines, removed: 0 } : { path, added: 0, removed: lines };
}

function patched(path: string, patch: Fields[]): FileLines {
  let added = 0;
  let removed = 0;
  for (const line of patch.flatMap((hunk) => hunk.lines as string[])) {
    if (line.startsWith('+')) added++;
    if (line.startsWith('-')) removed++;
  }
  return { path, added, removed };
}

function replacement(site: Fields): { added: number; removed: number } {
  const before = linesOf((site.line_prefix ?? '') + (site.old_string ?? ''));
  const after = linesOf((site.line_prefix ?? '') + (site.new_string ?? ''));
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before.at(-1 - tail) === after.at(-1 - tail)) tail++;
  return { added: after.length - head - tail, removed: before.length - head - tail };
}

function replaced(entry: Fields): FileLines {
  const sites: Fields[] = entry._meta?.details ?? [{ old_string: entry.oldText, new_string: entry.newText }];
  const hunks = sites.map(replacement);
  return {
    path: entry.path,
    added: hunks.reduce((sum, hunk) => sum + hunk.added, 0),
    removed: hunks.reduce((sum, hunk) => sum + hunk.removed, 0),
  };
}

function changedFiles(files: ReadonlyMap<string, { added: number; removed: number }>): Files {
  const changes = [...files.values()];
  return {
    count: files.size,
    added: changes.reduce((sum, change) => sum + change.added, 0),
    removed: changes.reduce((sum, change) => sum + change.removed, 0),
  };
}

function turnDiffFiles(diff: string): Files {
  const files = new Map<string, { added: number; removed: number }>();
  for (const section of diff.split(/^diff --git /m).filter((one) => one.trim() !== '')) {
    const header = section.split('\n')[0]!;
    const path = /^\+\+\+ b\/(.+)$/m.exec(section)?.[1] ?? header.slice(header.indexOf(' b/') + 3);
    files.set(path, changeCounts(section));
  }
  return changedFiles(files);
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

function heldStatus(held: Call): Status {
  if (!FINISHED.has(held.status)) return 'running';
  return held.status === 'failed' ? 'failed' : 'done';
}

function backgroundKey(id: string): string {
  return `background ${id}`;
}

abstract class Reader {
  session: string | null = null;
  protected readonly calls = new Map<string, Call>();
  private readonly owners = new Map<string, string | null>();
  private readonly backgrounds = new Map<string, Running>();
  private readonly work = new Map<string, Running>();
  private readonly seenOptions = new Map<string, unknown>();
  private readonly requestedOptions = new Map<string, unknown>();
  private readonly compactions = new Set<string>();
  private readonly turns = new Set<string>();
  private readonly edits = new Map<string, readonly FileLines[]>();
  protected abstract readonly watchedOptions: Record<string, NoticeKind>;

  read(message: Message): Event[] {
    if (message.method === undefined) return this.answered(message.result);
    const session = message.params?.sessionId as string | undefined;
    if (session !== undefined && this.session !== null && session !== this.session) {
      return this.elsewhere(session, message);
    }
    return this.own(message);
  }

  tap(_message: Message): Event[] {
    return [];
  }

  requested(option: string, value: unknown): void {
    this.requestedOptions.set(option, value);
  }

  refused(option: string): void {
    this.requestedOptions.delete(option);
  }

  began(): Event[] {
    this.edits.clear();
    return this.editedFiles();
  }

  closeTurn(): void {
    for (const [id, held] of this.calls) if (held.counted !== 'subagent') this.calls.delete(id);
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
    return this.update(message.params!.update as Fields, null);
  }

  protected extension(_message: Message): Event[] {
    return [];
  }

  protected update(update: Fields, parent: string | null): Event[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (parent !== null) return [];
        if (update.content.type === 'image') return [{ kind: 'image', data: update.content.data, mediaType: update.content.mimeType }];
        return update.content.type === 'text' ? [{ kind: 'text', id: update.messageId ?? null, text: update.content.text }] : [];
      case 'tool_call':
      case 'tool_call_update':
        return this.tool(update, parent);
      case 'usage_update':
        return [{ kind: 'state', state: this.used(update) }];
      case 'current_mode_update':
        return [{ kind: 'notice', notice: 'mode', text: update.currentModeId }];
      case 'available_commands_update':
        return [{ kind: 'commands', commands: update.availableCommands }];
      case 'config_option_update':
        return [{ kind: 'options', options: update.configOptions }, ...this.optionsChanged(update.configOptions)];
      case 'compaction_update':
        if (update.status !== 'completed' || this.compactions.has(update.compactionId)) return [];
        this.compactions.add(update.compactionId);
        return [{ kind: 'notice', notice: 'compaction', text: '' }];
      case 'session_info_update':
        return this.info(update);
      case 'notice': {
        const said = [update.title, update.description].filter((text) => typeof text === 'string' && text !== '');
        return [{ kind: 'notice', notice: NOTICES[update.severity] ?? 'info', text: said.join('\n') }];
      }
      case 'async_task_spawned':
        if (update.taskType === 'turn') {
          this.turns.add(update.asyncTaskId);
          return [];
        }
        this.handedOff(update.toolCallId);
        return this.background(update.asyncTaskId, update.taskType === 'shell' || update.taskType === 'monitor' ? update.taskType : 'task', 'running');
      case 'async_task_state_update':
        if (this.turns.has(update.asyncTaskId)) {
          if (!RUNNING_JOB.has(update.state)) this.turns.delete(update.asyncTaskId);
          return [];
        }
        if (RUNNING_JOB.has(update.state) || !this.backgrounds.has(update.asyncTaskId)) return [];
        return this.background(update.asyncTaskId, this.backgrounds.get(update.asyncTaskId)!, ENDED[update.state] ?? 'done');
      default:
        return [];
    }
  }

  protected used(update: Fields): Partial<SessionState> {
    return { context: { used: update.used, window: update.size, breakdown: [] } };
  }

  private info(update: Fields): Event[] {
    const suggestion = update._meta?.promptSuggestions?.suggestions?.[0]?.text;
    const state: Partial<SessionState> = {
      ...(typeof update.title === 'string' ? { title: update.title } : {}),
      ...(typeof suggestion === 'string' ? { suggestion } : {}),
    };
    return Object.keys(state).length === 0 ? [] : [{ kind: 'state', state }];
  }

  protected handedOff(id: string | undefined): void {
    const held = id === undefined ? undefined : this.calls.get(id);
    if (held !== undefined && !FINISHED.has(held.status)) held.status = 'completed';
  }

  protected background(id: string, kind: Running, status: Status): Event[] {
    if (status === 'running') this.backgrounds.set(id, kind);
    else this.backgrounds.delete(id);
    return this.runs(backgroundKey(id), status === 'running' ? kind : null);
  }

  protected forget(id: string): Event[] {
    this.backgrounds.delete(id);
    return this.runs(backgroundKey(id), null);
  }

  protected runs(key: string, running: Running | null): Event[] {
    const before = this.work.get(key) ?? null;
    if (running === null) this.work.delete(key);
    else this.work.set(key, running);
    if (before === running) return [];
    const counts = new Map<Running, number>();
    for (const kind of this.work.values()) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    return [{ kind: 'state', state: { running: [...counts].map(([kind, count]) => ({ kind, count })) } }];
  }

  private optionsChanged(options: Fields[]): Event[] {
    const events: Event[] = [];
    for (const option of options) {
      const notice = this.watchedOptions[option.id];
      const before = this.seenOptions.get(option.id);
      this.seenOptions.set(option.id, option.currentValue);
      if (notice === undefined || before === undefined || before === option.currentValue) continue;
      if (this.requestedOptions.get(option.id) === option.currentValue) {
        this.requestedOptions.delete(option.id);
        continue;
      }
      events.push({ kind: 'notice', notice, text: String(option.currentValue) });
    }
    return events;
  }

  protected tool(update: Fields, parent: string | null): Event[] {
    let held = this.calls.get(update.toolCallId);
    if (held === undefined) {
      if (update.sessionUpdate !== 'tool_call') return [];
      held = { id: update.toolCallId, parent, counted: null, meta: {}, imaged: false, status: 'in_progress' };
      this.calls.set(held.id, held);
    }
    if (update.kind !== undefined) held.kind = update.kind;
    if (update.title !== undefined) held.title = update.title;
    if (update.status !== undefined && !FINISHED.has(held.status)) held.status = update.status;
    if (update.rawInput !== undefined) held.rawInput = merged(held.rawInput ?? {}, update.rawInput as Fields);
    if (update.rawOutput !== undefined) held.rawOutput = update.rawOutput;
    if (update.content !== undefined) held.content = update.content;
    held.meta = merged(held.meta, (update._meta ?? {}) as Fields);
    return this.shown(held);
  }

  protected shown(held: Call): Event[] {
    const first = held.counted === null;
    held.counted ??= this.kindOf(held);
    if (held.counted === 'plan') return [];
    if (held.counted === 'subagent') return this.subagent(held.id, held.parent, this.subagentStatus(held), first);
    const call: Called = { kind: held.counted, files: held.counted === 'edit' ? this.filesOf(held) : [], failed: this.failed(held) };
    return [{ kind: 'call', key: held.id, parent: held.parent, first, call, running: null }, ...this.edited(held.id, call), ...this.produced(held)];
  }

  protected subagent(key: string, parent: string | null, status: Status, first: boolean): Event[] {
    if (!this.owners.has(key)) this.owners.set(key, parent);
    const running = status === 'running';
    const call: Called = { kind: 'other', files: [], failed: status === 'failed' };
    return [
      { kind: 'call', key, parent: this.owners.get(key)!, first, call, running },
      ...this.runs(key, running ? 'subagent' : null),
    ];
  }

  protected subagentStatus(held: Call): Status {
    return heldStatus(held);
  }

  private failed(held: Call): boolean {
    if (held.status === 'failed') return true;
    const exit = held.rawOutput?.exit_code;
    return held.counted === 'command' && FINISHED.has(held.status) && typeof exit === 'number' && exit !== 0;
  }

  protected filesFromEdits(): boolean {
    return true;
  }

  private edited(key: string, call: Called): Event[] {
    if (call.kind !== 'edit' || !this.filesFromEdits()) return [];
    this.edits.set(key, call.files);
    return this.editedFiles();
  }

  private editedFiles(): Event[] {
    const files = new Map<string, { added: number; removed: number }>();
    for (const change of [...this.edits.values()].flat()) {
      const held = files.get(change.path);
      files.set(change.path, { added: (held?.added ?? 0) + change.added, removed: (held?.removed ?? 0) + change.removed });
    }
    return [{ kind: 'state', state: { files: changedFiles(files) } }];
  }

  protected produced(_call: Call): Event[] {
    return [];
  }

  protected abstract kindOf(call: Call): Counting;

  protected abstract filesOf(call: Call): FileLines[];
}

class ClaudeReader extends Reader {
  protected override readonly watchedOptions: Record<string, NoticeKind> = { model: 'model' };
  private readonly settled = new Map<string, Status>();
  private readonly answers = new Map<string, Fields>();
  private readonly windows = new Map<string, Limit>();
  private readonly crons = new Map<string, string>();
  private readonly wakeups = new Map<string, number>();
  private breakdown: readonly { readonly name: string; readonly tokens: number }[] = [];
  private stop: Stop | null = null;

  protected override answered(result: Fields | undefined): Event[] {
    const models = (result?._meta?.quota?.model_usage ?? []) as Fields[];
    const spent = counted(
      models.map(({ token_count: count }) => ({
        input: count?.inputTokens,
        output: count?.outputTokens,
        cache_read: count?.cachedInputTokens,
        cache_write: count?.cachedWriteTokens,
      })),
    );
    return [...spent, ...super.answered(result)];
  }

  override began(): Event[] {
    const fired = [...this.wakeups].filter(([, next]) => next <= Date.now()).map(([id]) => id);
    for (const id of fired) this.wakeups.delete(id);
    return [...super.began(), ...fired.flatMap((id) => this.forget(id))];
  }

  protected override own(message: Message): Event[] {
    const update = message.params?.update as Fields | undefined;
    const parent = update?._meta?.claudeCode?.parentToolUseId as string | undefined;
    if (parent === undefined) return super.own(message);
    return update!.sessionUpdate === 'tool_call' || update!.sessionUpdate === 'tool_call_update' ? this.tool(update!, parent) : [];
  }

  protected override used(update: Fields): Partial<SessionState> {
    const cost = update.cost as Fields | undefined;
    return {
      context: { used: update.used, window: update.size, breakdown: this.breakdown },
      ...(typeof cost?.amount === 'number' ? { cost: { amount: cost.amount, currency: cost.currency } } : {}),
    };
  }

  protected override update(update: Fields, parent: string | null): Event[] {
    if (update.sessionUpdate === 'usage_update' && update._meta?.['_claude/origin'] !== undefined) {
      const stop = this.stop;
      this.stop = null;
      return [...super.update(update, parent), { kind: 'ended', stop }];
    }
    if (update.sessionUpdate === 'session_info_update' && update._meta?.jetbrains?.air?.sessionFailure !== undefined) {
      return [{ kind: 'notice', notice: 'retry', text: update._meta.jetbrains.air.sessionFailure.title }];
    }
    return super.update(update, parent);
  }

  protected override extension(message: Message): Event[] {
    if (message.method !== '_claude/sdkMessage') return [];
    const sdk = message.params!.message as Fields;
    switch (sdk.type) {
      case 'result':
        if (AUTONOMOUS_ORIGINS.has(sdk.origin?.kind)) this.stop = null;
        else this.stop = sdk.stop_reason === 'refusal' ? 'refusal' : sdk.is_error === true ? null : 'end_turn';
        return count(sdk.duration_ms) === null ? [] : [{ kind: 'state', state: { duration: sdk.duration_ms } }];
      case 'assistant':
        return this.assistant(sdk);
      case 'user':
        return this.user(sdk);
      case 'rate_limit_event':
        return this.limited(sdk.rate_limit_info as Fields);
    }
    if (typeof sdk.tool_use_id !== 'string' || sdk.subtype !== 'task_notification') return [];
    return this.settle(sdk.tool_use_id, ENDED[sdk.status] ?? 'done');
  }

  private settle(key: string, status: Status): Event[] {
    const held = this.calls.get(key);
    if (held?.counted !== 'subagent' && held !== undefined) return [];
    this.settled.set(key, status);
    return held === undefined ? [] : this.shown(held);
  }

  private assistant(sdk: Fields): Event[] {
    const usage = sdk.context_usage as Fields | undefined;
    if (usage === undefined) return [];
    this.breakdown = (usage.categories as Fields[]).map((category) => ({ name: category.name, tokens: category.tokens }));
    return [{ kind: 'state', state: { context: { used: usage.total_tokens, window: usage.raw_max_tokens, breakdown: this.breakdown } } }];
  }

  private user(sdk: Fields): Event[] {
    const content = sdk.message?.content;
    if (!Array.isArray(content)) return [];
    const events: Event[] = [];
    for (const block of content as Fields[]) {
      if (block.type !== 'tool_result') continue;
      this.answers.set(block.tool_use_id, (sdk.tool_use_result ?? {}) as Fields);
      const held = this.calls.get(block.tool_use_id);
      if (held !== undefined) events.push(...this.shown(held));
    }
    return events;
  }

  private limited(info: Fields | undefined): Event[] {
    for (const [name, window] of Object.entries((info?.unifiedWindows ?? {}) as Record<string, Fields>)) {
      const minutes = WINDOW_MINUTES[name] ?? WINDOW_MINUTES[name.replace(/_[a-z]+$/, '')];
      if (typeof window.utilization !== 'number' || minutes === undefined) continue;
      this.windows.set(name, {
        name: name in WINDOW_MINUTES ? null : name,
        minutes,
        percent: Math.round(window.utilization * 1000) / 10,
        resets: typeof window.resetsAt === 'number' ? instant(window.resetsAt * 1000) : null,
      });
    }
    return this.windows.size === 0 ? [] : [{ kind: 'state', state: { limits: [...this.windows.values()] } }];
  }

  private toolName(held: Call): string {
    return (held.meta.claudeCode?.toolName as string | undefined) ?? '';
  }

  protected override kindOf(held: Call): Counting {
    const tool = this.toolName(held);
    if (tool === 'Agent' || tool === 'Task' || held.meta.jetbrains?.air?.subagent === true) return 'subagent';
    if (tool.startsWith('mcp__')) return 'other';
    if (tool === 'Bash') return 'command';
    return held.kind === 'edit' ? 'edit' : 'other';
  }

  protected override subagentStatus(held: Call): Status {
    const settled = this.settled.get(held.id);
    if (settled !== undefined) return settled;
    const answered = this.answers.get(held.id);
    const launched = held.meta.claudeCode?.toolResponse?.isAsync === true || answered?.status === 'async_launched';
    if (launched || (!FINISHED.has(held.status) && answered === undefined)) return 'running';
    return held.status === 'failed' ? 'failed' : 'done';
  }

  protected override filesOf(held: Call): FileLines[] {
    const result = this.answers.get(held.id) ?? {};
    const path = result.filePath ?? held.rawInput?.file_path;
    if (typeof path !== 'string') return [];
    if (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0) return [patched(path, result.structuredPatch)];
    if (result.type === 'create' && typeof result.content === 'string') return [wholeFile(path, '+', result.content)];
    return [{ path, added: 0, removed: 0 }];
  }

  protected override produced(held: Call): Event[] {
    if (held.status !== 'completed') return [];
    const tool = this.toolName(held);
    const result = this.answers.get(held.id) ?? {};
    if (tool === 'CronCreate' && typeof result.id === 'string' && !this.crons.has(result.id)) {
      this.crons.set(result.id, held.id);
      return this.background(held.id, 'schedule', 'running');
    }
    if (tool === 'CronDelete' && typeof held.rawInput?.id === 'string' && this.crons.has(held.rawInput.id)) {
      const created = this.crons.get(held.rawInput.id)!;
      this.crons.delete(held.rawInput.id);
      return this.background(created, 'schedule', 'stopped');
    }
    if (tool !== 'ScheduleWakeup' || this.wakeups.has(held.id)) return [];
    if (held.rawInput?.stop === true) {
      const stopped = [...this.wakeups.keys()];
      this.wakeups.clear();
      return stopped.flatMap((id) => this.background(id, 'schedule', 'stopped'));
    }
    const seconds = WAKEUP.exec(contentText(held.content))?.[1];
    if (seconds === undefined) return [];
    const next = Date.now() + Number(seconds) * 1000;
    this.wakeups.set(held.id, next);
    return this.background(held.id, 'schedule', 'running');
  }
}

class CodexReader extends Reader {
  protected override readonly watchedOptions: Record<string, NoticeKind> = { mode: 'mode', collaboration_mode: 'mode' };
  private readonly children = new Set<string>();
  private readonly items = new Map<string, Fields>();

  protected override answered(result: Fields | undefined): Event[] {
    const usage = result?.usage as Fields | null | undefined;
    const spent =
      usage === null || usage === undefined
        ? []
        : counted([
            {
              input: usage.inputTokens,
              output: usage.outputTokens,
              cache_read: usage.cachedReadTokens,
              cache_write: usage.cachedWriteTokens,
            },
          ]);
    return [...spent, ...super.answered(result)];
  }

  protected override filesFromEdits(): boolean {
    return false;
  }

  override tap(message: Message): Event[] {
    const params = (message.params ?? {}) as Fields;
    if (message.method === 'account/rateLimits/updated') return this.limited(params.rateLimits as Fields);
    if (params.threadId !== this.session && !this.children.has(params.threadId)) return [];
    switch (message.method) {
      case 'item/started':
      case 'item/completed': {
        this.items.set(params.item.id, params.item);
        const held = this.calls.get(params.item.id);
        return held === undefined ? [] : this.shown(held);
      }
      case 'turn/completed':
        return params.threadId === this.session && count(params.turn?.durationMs) !== null ? [{ kind: 'state', state: { duration: params.turn.durationMs } }] : [];
      case 'turn/diff/updated':
        return params.threadId === this.session ? [{ kind: 'state', state: { files: turnDiffFiles(params.diff) } }] : [];
      default:
        return [];
    }
  }

  private limited(limits: Fields | undefined): Event[] {
    const windows = [limits?.primary, limits?.secondary].filter((window): window is Fields => typeof window?.usedPercent === 'number');
    if (windows.length === 0) return [];
    const name = typeof limits!.limitName === 'string' ? limits!.limitName : null;
    const limited = windows.map((window) => ({
      name,
      // Codex sends each window's length; a limit always carries one, so a window Codex sends without it has 0.
      minutes: count(window.windowDurationMins) ?? 0,
      percent: window.usedPercent,
      resets: typeof window.resetsAt === 'number' ? instant(window.resetsAt * 1000) : null,
    }));
    return [{ kind: 'state', state: { limits: limited } }];
  }

  protected override own(message: Message): Event[] {
    if (message.method === 'session/request_permission' && message.params!.toolCall?.kind === 'switch_mode') {
      return [{ kind: 'started' }, { kind: 'notice', notice: 'mode', text: message.params!.toolCall.title ?? '' }];
    }
    return super.own(message);
  }

  protected override update(update: Fields, parent: string | null): Event[] {
    switch (update.sessionUpdate) {
      case 'session_info_update': {
        const codex = update._meta?.codex as Fields | undefined;
        if (codex?.threadStatus?.type === 'active') return [{ kind: 'started' }];
        if (codex?.threadStatus?.type === 'idle') return [{ kind: 'ended', stop: null }];
        if (codex?.error !== undefined) return [{ kind: 'notice', notice: 'retry', text: codex.error.message ?? '' }];
        return super.update(update, parent);
      }
      case 'subagent_spawned': {
        const first = !this.children.has(update.subagentSessionId);
        this.children.add(update.subagentSessionId);
        return this.subagent(update.subagentSessionId, parent, 'running', first);
      }
      case 'subagent_state_update':
        if (!this.children.has(update.subagentSessionId)) return [];
        return this.subagent(update.subagentSessionId, parent, ENDED[update.state] ?? 'failed', false);
      default:
        return super.update(update, parent);
    }
  }

  protected override elsewhere(session: string, message: Message): Event[] {
    const update = message.params?.update as Fields | undefined;
    if (!this.children.has(session) || update === undefined) return [];
    if (update.sessionUpdate === 'subagent_spawned' || update.sessionUpdate === 'subagent_state_update') return this.update(update, session);
    return CHILD_UPDATES.has(update.sessionUpdate) ? this.update(update, session) : [];
  }

  protected override kindOf(held: Call): Counting {
    if (held.meta.is_mcp_tool_call === true) return 'other';
    if (held.kind === 'execute') return 'command';
    return held.kind === 'edit' ? 'edit' : 'other';
  }

  protected override filesOf(held: Call): FileLines[] {
    const item = this.items.get(held.id);
    if (item?.type !== 'fileChange') return [];
    return (item.changes as Fields[]).map((change) => {
      if (change.kind?.type === 'add') return wholeFile(change.path, '+', change.diff);
      if (change.kind?.type === 'delete') return wholeFile(change.path, '-', change.diff);
      return { path: change.kind?.move_path ?? change.path, ...changeCounts(change.diff) };
    });
  }

  protected override produced(held: Call): Event[] {
    if (held.imaged || held.kind === 'read' || held.parent !== null) return [];
    const image = (held.content ?? []).find((entry) => entry.type === 'content' && entry.content?.type === 'image');
    if (image === undefined) return [];
    held.imaged = true;
    return [{ kind: 'image', data: image.content.data, mediaType: image.content.mimeType }];
  }
}

class GrokReader extends Reader {
  protected override readonly watchedOptions: Record<string, NoticeKind> = {};
  private readonly children = new Map<string, string | null>();
  private readonly settled = new Map<string, Status>();
  private readonly schedules = new Set<string>();
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
      return (message.params!.runningPromptId ?? null) !== null && session === this.session ? [{ kind: 'started' }] : [];
    }
    if (message.params?.update?.sessionUpdate === 'turn_completed') {
      if (session !== this.session) return [];
      return [...this.spent(message.params.update.usage as Fields | null | undefined), { kind: 'ended', stop: null }];
    }
    if (message.method === '_x.ai/models/update') {
      this.offered(message.params!);
      return [];
    }
    return super.read(message);
  }

  protected override elsewhere(session: string, message: Message): Event[] {
    const parent = this.children.get(session);
    const update = message.params?.update as Fields | undefined;
    if (typeof parent !== 'string' || message.method !== 'session/update' || !CHILD_UPDATES.has(update?.sessionUpdate)) return [];
    return this.update(update!, parent);
  }

  private spent(usage: Fields | null | undefined): Event[] {
    if (usage === null || usage === undefined) return [];
    const { inputTokens, outputTokens, cachedReadTokens, cacheCreationTokens } = usage;
    const input = inputTokens - cachedReadTokens - cacheCreationTokens;
    return counted([{ input, output: outputTokens, cache_read: cachedReadTokens, cache_write: cacheCreationTokens }]);
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
        this.handedOff(update!.tool_call_id);
        return this.background(update!.task_id, 'shell', 'running');
      case '_x.ai/task_completed': {
        const snapshot = update!.task_snapshot as Fields;
        return this.background(snapshot.task_id, 'shell', snapshot.exit_code === 0 ? 'done' : 'failed');
      }
      case '_x.ai/scheduled_task_created': {
        this.schedules.add(update!.task_id);
        return this.background(update!.task_id, 'schedule', 'running');
      }
      case '_x.ai/scheduled_task_deleted':
        return this.schedules.delete(update!.task_id) ? this.background(update!.task_id, 'schedule', 'stopped') : [];
      case '_x.ai/session_notification':
        return this.notification(update!);
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
        return [{ kind: 'state', state: { context: { used, window, breakdown: [] } } }];
      }
      case 'subagent_spawned': {
        const linked = [...this.children.values()];
        const unlinked = [...this.calls.values()].filter((candidate) => candidate.counted === 'subagent' && !linked.includes(candidate.id));
        const held = unlinked.find((candidate) => candidate.rawInput?.description === update.description);
        this.children.set(update.child_session_id, held?.id ?? null);
        return [];
      }
      case 'subagent_finished': {
        const key = this.children.get(update.child_session_id);
        if (typeof key !== 'string') return [];
        this.settled.set(key, ENDED[update.status] ?? 'failed');
        const held = this.calls.get(key);
        return held === undefined ? [] : this.shown(held);
      }
      case 'auto_compact_completed':
        return [{ kind: 'notice', notice: 'compaction', text: '' }];
      case 'model_auto_switched':
        this.model = update.new_model_id;
        return [{ kind: 'notice', notice: 'model', text: update.new_model_id }];
      case 'retry_state':
        return [{ kind: 'notice', notice: 'retry', text: update.message ?? update.reason ?? update.error_type ?? '' }];
      default:
        return [];
    }
  }

  private xai(held: Call): Fields {
    return (held.meta['x.ai/tool'] ?? {}) as Fields;
  }

  protected override kindOf(held: Call): Counting {
    const tool = this.xai(held);
    if (tool.name === 'spawn_subagent' || tool.kind === 'task') return 'subagent';
    if (tool.kind === 'plan') return 'plan';
    if (tool.name === 'run_terminal_command') return 'command';
    const kind = tool.kind ?? held.kind;
    if (kind === 'execute') return 'command';
    return kind === 'write' || kind === 'edit' ? 'edit' : 'other';
  }

  protected override subagentStatus(held: Call): Status {
    return this.settled.get(held.id) ?? (held.status === 'failed' ? 'failed' : 'running');
  }

  protected override filesOf(held: Call): FileLines[] {
    return (held.content ?? []).filter((entry) => entry.type === 'diff').map(replaced);
  }
}

export type { Reader };

export interface AnsweredFailure {
  title: string;
  limit: boolean;
}

export function answeredFailure(answer: Fields): AnsweredFailure | null {
  const failure = answer._meta?.jetbrains?.air?.sessionFailure;
  return typeof failure?.title === 'string' ? { title: failure.title, limit: failure.category === 'limit' } : null;
}

export function readerFor(kind: string): Reader {
  if (kind === 'claude-agent-acp') return new ClaudeReader();
  if (kind === 'grok-build') return new GrokReader();
  return new CodexReader();
}
