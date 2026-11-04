import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk';
import { firstPart, keptDiff, lastLines, type FileChange, type SessionState, type Status, type Tokens } from '@agentshouse/session-content';
import type { PlanEntry, Placed } from './content.ts';

type Fields = Record<string, any>;

export interface Message {
  id?: unknown;
  method?: string;
  params?: Fields;
  result?: Fields;
}

export type Stop = 'end_turn' | 'refusal';

export type NoticeKind = Extract<Placed, { type: 'notice' }>['kind'];

type Subagent = Extract<Placed, { type: 'subagent' }>;

type Background = Extract<Placed, { type: 'background' }>;

type Running = SessionState['running'][number];

type Limit = SessionState['limits'][number];

export type Event =
  | { kind: 'started' }
  | { kind: 'ended'; stop: Stop | null }
  | { kind: 'text' | 'reasoning'; id: string | null; parent: string | null; text: string }
  | { kind: 'part'; key: string; parent: string | null; part: Placed }
  | { kind: 'notice'; notice: NoticeKind; text: string }
  | { kind: 'plan'; entries: PlanEntry[] }
  | { kind: 'image'; data: string; mediaType: string; parent: string | null }
  | { kind: 'state'; state: Partial<SessionState> }
  | { kind: 'tokens'; tokens: Tokens }
  | { kind: 'commands'; commands: AvailableCommand[] }
  | { kind: 'options'; options: SessionConfigOption[] };

type Shown = 'call' | 'subagent' | 'message';

interface Call {
  id: string;
  parent: string | null;
  shown: Shown | null;
  kind?: string;
  title?: string;
  status: string;
  rawInput?: Fields;
  rawOutput?: any;
  content?: Fields[];
  meta: Fields;
  output: string;
  exit: number | null;
  imaged: boolean;
}

type Detail =
  | { kind: 'command' }
  | { kind: 'read' | 'search'; returned: number | null }
  | { kind: 'edit'; files: FileChange[] }
  | { kind: 'fetch' | 'tool' | 'other'; output: string };

interface HouseMessage {
  command: string;
  target: string | null;
}

const AUTONOMOUS_ORIGINS = new Set(['task-notification', 'peer', 'coordinator', 'observer', 'observer-activity']);

const FINISHED = new Set(['completed', 'failed', 'stopped']);
export const RUNNING_JOB = new Set(['running', 'paused']);
const MESSAGE_TARGETS = new Map([
  ['agent-functions/send', ['agent_function', 'agent']],
  ['agent-functions/cancel', ['request']],
  ['agent-functions/mail/send', ['conversation', 'request']],
]);
const PLANNED: Record<string, PlanEntry['status']> = { pending: 'pending', in_progress: 'running', completed: 'done' };
const ENDED: Record<string, Status> = { completed: 'done', failed: 'failed', stopped: 'stopped', killed: 'stopped', cancelled: 'stopped' };
const NOTICES: Record<string, NoticeKind> = { info: 'info', warning: 'warning', error: 'error' };
const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10_080 };
const WAKEUP = /Next wakeup scheduled for \d\d:\d\d:\d\d \(in (\d+)s\)/;
const CHILD_UPDATES = new Set(['tool_call', 'tool_call_update', 'agent_message_chunk', 'agent_thought_chunk']);

function counted(reports: Tokens[]): Event[] {
  const whole = reports.every((tokens) => Object.values(tokens).every((count) => Number.isSafeInteger(count) && count >= 0));
  return whole ? reports.map((tokens) => ({ kind: 'tokens', tokens })) : [];
}

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

function houseMessage(line: string): HouseMessage | null {
  const [program, verb, json] = words(line.trim());
  if (program !== 'house' || verb !== 'run_command' || json === undefined) return null;
  let call: Fields | null;
  try {
    call = JSON.parse(json) as Fields | null;
  } catch {
    return null;
  }
  if (call === null) return null;
  const targets = MESSAGE_TARGETS.get(call.command);
  if (targets === undefined) return null;
  const target = targets.map((argument) => call.arguments?.[argument]).find((value) => typeof value === 'string');
  return { command: call.command, target: target ?? null };
}

function lineOf(command: unknown): string | undefined {
  const line = typeof command === 'string' ? command : Array.isArray(command) ? command.at(-1) : undefined;
  return typeof line === 'string' ? line : undefined;
}

function contentText(content: Fields[] | undefined): string {
  return (content ?? [])
    .map((entry) => (entry.type === 'content' && entry.content?.type === 'text' ? entry.content.text : ''))
    .filter((part: string) => part !== '')
    .join('\n');
}

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: Fields) => (block.type === 'text' ? block.text : ''))
    .filter((part: string) => part !== '')
    .join('\n');
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function statusOf(acp: string): Status {
  if (acp === 'completed') return 'done';
  if (acp === 'failed' || acp === 'stopped') return acp;
  return 'running';
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

function fileChange(path: string, diff: string): FileChange {
  return { path, ...changeCounts(diff), diff: keptDiff(diff) };
}

function wholeFile(path: string, sign: '+' | '-', text: string): FileChange {
  const lines = text.replace(/\n$/, '').split('\n');
  const range = sign === '+' ? `-0,0 +1,${lines.length}` : `-1,${lines.length} +0,0`;
  return fileChange(path, `@@ ${range} @@\n${lines.map((line) => `${sign}${line}`).join('\n')}\n`);
}

function hunks(patch: Fields[]): string {
  return patch
    .map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${(hunk.lines as string[]).join('\n')}\n`)
    .join('');
}

function linesOf(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

function replacement(site: Fields): { added: number; removed: number; diff: string } {
  const before = linesOf(site.old_string ?? '');
  const after = linesOf(site.new_string ?? '');
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before.at(-1 - tail) === after.at(-1 - tail)) tail++;
  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);
  const lines = [...removed.map((line) => `-${line}\n`), ...added.map((line) => `+${line}\n`)].join('');
  const from = (line: number | undefined, kept: string[]) => (line ?? 1) + head - (kept.length === 0 ? 1 : 0);
  const header = `@@ -${from(site.old_line, removed)},${removed.length} +${from(site.new_line, added)},${added.length} @@\n`;
  return { added: added.length, removed: removed.length, diff: lines === '' ? '' : header + lines };
}

function replaced(entry: Fields): FileChange {
  const sites: Fields[] = entry._meta?.details ?? [
    { old_string: entry.oldText, new_string: entry.newText, old_line: entry._meta?.old_line, new_line: entry._meta?.new_line },
  ];
  const hunks = sites.map(replacement);
  return {
    path: entry.path,
    added: hunks.reduce((sum, hunk) => sum + hunk.added, 0),
    removed: hunks.reduce((sum, hunk) => sum + hunk.removed, 0),
    diff: keptDiff(hunks.map((hunk) => hunk.diff).join('')),
  };
}

function turnDiffFiles(diff: string): SessionState['files'] {
  return diff
    .split(/^diff --git /m)
    .filter((section) => section.trim() !== '')
    .map((section) => {
      const header = section.split('\n')[0]!;
      const path = /^\+\+\+ b\/(.+)$/m.exec(section)?.[1] ?? header.slice(header.indexOf(' b/') + 3);
      return { path, ...changeCounts(section) };
    });
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

function call(held: Pick<Call, 'status' | 'exit' | 'output'>, line: string, detail: Detail, duration: number | null = null): Placed {
  const base = { type: 'call' as const, line, status: statusOf(held.status), duration };
  switch (detail.kind) {
    case 'command':
      return { ...base, kind: 'command', exit: held.exit, output: held.output };
    case 'read':
    case 'search':
      return { ...base, kind: detail.kind, returned: detail.returned };
    case 'edit':
      return { ...base, kind: 'edit', files: detail.files };
    default:
      return { ...base, kind: detail.kind, output: firstPart(detail.output) };
  }
}

function startedAgent(task: string, name: string | null = null): Subagent {
  return { type: 'subagent', kind: 'agent', name, task, status: 'running', step: null, report: null, tokens: null, calls: null, duration: null };
}

function backgroundKey(id: string): string {
  return `background ${id}`;
}

abstract class Reader {
  session: string | null = null;
  protected readonly calls = new Map<string, Call>();
  protected readonly subagents = new Map<string, Subagent>();
  private readonly owners = new Map<string, string | null>();
  private readonly backgrounds = new Map<string, Background>();
  private readonly work = new Map<string, Running>();
  private readonly seenOptions = new Map<string, unknown>();
  private readonly requestedOptions = new Map<string, unknown>();
  private readonly compactions = new Set<string>();
  private readonly turns = new Set<string>();
  private readonly edits = new Map<string, readonly FileChange[]>();
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

  closeTurn(): Event[] {
    const events: Event[] = [];
    for (const [id, held] of this.calls) {
      if (held.shown === 'subagent') continue;
      this.calls.delete(id);
      held.shown ??= this.decide(held, true);
      if (!FINISHED.has(held.status)) held.status = 'stopped';
      events.push(...this.shown(held));
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
    return this.update(message.params!.update as Fields, null);
  }

  protected extension(_message: Message): Event[] {
    return [];
  }

  protected update(update: Fields, parent: string | null): Event[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'image') return [{ kind: 'image', data: update.content.data, mediaType: update.content.mimeType, parent }];
        return update.content.type === 'text' ? [{ kind: 'text', id: update.messageId ?? null, parent, text: update.content.text }] : [];
      case 'agent_thought_chunk':
        return update.content.type === 'text' ? [{ kind: 'reasoning', id: update.messageId ?? null, parent, text: update.content.text }] : [];
      case 'tool_call':
      case 'tool_call_update':
        return this.tool(update, parent);
      case 'plan':
        return [{ kind: 'plan', entries: (update.entries as Fields[]).map((entry) => ({ content: entry.content, status: PLANNED[entry.status] ?? 'pending' })) }];
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
        return [
          ...this.handedOff(update.toolCallId),
          ...this.background(update.asyncTaskId, update.taskType === 'shell' || update.taskType === 'monitor' ? update.taskType : 'task', update.name ?? update.description ?? '', 'running'),
        ];
      case 'async_task_progress': {
        const held = this.backgrounds.get(update.asyncTaskId);
        const progress = update.description ?? update.summary;
        if (held === undefined || typeof progress !== 'string') return [];
        return this.runs(backgroundKey(update.asyncTaskId), { kind: held.kind, label: held.label, progress, next: null });
      }
      case 'async_task_state_update':
        if (this.turns.has(update.asyncTaskId)) {
          if (!RUNNING_JOB.has(update.state)) this.turns.delete(update.asyncTaskId);
          return [];
        }
        if (RUNNING_JOB.has(update.state) || !this.backgrounds.has(update.asyncTaskId)) return [];
        return this.background(update.asyncTaskId, this.backgrounds.get(update.asyncTaskId)!.kind, null, ENDED[update.state] ?? 'done');
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

  protected handedOff(id: string | undefined): Event[] {
    const held = id === undefined ? undefined : this.calls.get(id);
    if (held === undefined || FINISHED.has(held.status)) return [];
    held.status = 'completed';
    return this.shown(held);
  }

  protected background(id: string, kind: Background['kind'], label: string | null, status: Status, next: string | null = null): Event[] {
    const part: Background = { type: 'background', kind, label: label ?? this.backgrounds.get(id)?.label ?? '', status };
    if (status === 'running') this.backgrounds.set(id, part);
    else this.backgrounds.delete(id);
    return [
      { kind: 'part', key: backgroundKey(id), parent: null, part },
      ...this.runs(backgroundKey(id), status === 'running' ? { kind, label: part.label, progress: null, next } : null),
    ];
  }

  protected forget(id: string): Event[] {
    this.backgrounds.delete(id);
    return this.runs(backgroundKey(id), null);
  }

  protected runs(key: string, running: Running | null): Event[] {
    const before = JSON.stringify([...this.work.values()]);
    if (running === null) this.work.delete(key);
    else this.work.set(key, running);
    const now = [...this.work.values()];
    return JSON.stringify(now) === before ? [] : [{ kind: 'state', state: { running: now } }];
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
      held = { id: update.toolCallId, parent, shown: null, meta: {}, output: '', exit: null, imaged: false, status: 'in_progress' };
      this.calls.set(held.id, held);
    }
    if (update.kind !== undefined) held.kind = update.kind;
    if (update.title !== undefined) held.title = update.title;
    if (update.status !== undefined && !FINISHED.has(held.status)) held.status = update.status;
    if (update.rawInput !== undefined) held.rawInput = merged(held.rawInput ?? {}, update.rawInput as Fields);
    if (update.rawOutput !== undefined) held.rawOutput = update.rawOutput;
    if (update.content !== undefined) held.content = update.content;
    const meta = (update._meta ?? {}) as Fields;
    if (typeof meta.terminal_output?.data === 'string') held.output = lastLines(held.output + meta.terminal_output.data);
    if (meta.terminal_exit !== undefined) held.exit = meta.terminal_exit.exit_code ?? null;
    held.meta = merged(held.meta, meta);
    return this.shown(held);
  }

  protected shown(held: Call): Event[] {
    held.shown ??= this.decide(held, FINISHED.has(held.status));
    if (held.shown === null) return [];
    if (held.shown === 'subagent') return this.subagent(held.id, held.parent, this.subagentOf(held));
    if (held.shown === 'message') {
      const message = houseMessage(lineOf(held.rawInput?.command) ?? held.title ?? '')!;
      return [{ kind: 'part', key: held.id, parent: held.parent, part: { type: 'message', command: message.command, target: message.target } }];
    }
    const part = this.callOf(held);
    return [{ kind: 'part', key: held.id, parent: held.parent, part }, ...this.edited(held.id, part), ...this.produced(held)];
  }

  protected subagent(key: string, parent: string | null, part: Subagent): Event[] {
    if (!this.owners.has(key)) this.owners.set(key, parent);
    if (part.status === 'running') this.subagents.set(key, part);
    else this.subagents.delete(key);
    return [
      { kind: 'part', key, parent: this.owners.get(key)!, part },
      ...this.runs(key, part.status === 'running' ? { kind: 'subagent', label: part.task, progress: part.step, next: null } : null),
    ];
  }

  protected filesFromEdits(): boolean {
    return true;
  }

  private edited(key: string, part: Placed): Event[] {
    if (part.type !== 'call' || part.kind !== 'edit' || !this.filesFromEdits()) return [];
    this.edits.set(key, part.files);
    return this.editedFiles();
  }

  private editedFiles(): Event[] {
    const files = new Map<string, SessionState['files'][number]>();
    for (const change of [...this.edits.values()].flat()) {
      const held = files.get(change.path);
      files.set(change.path, { path: change.path, added: (held?.added ?? 0) + change.added, removed: (held?.removed ?? 0) + change.removed });
    }
    return [{ kind: 'state', state: { files: [...files.values()] } }];
  }

  protected decideLine(line: string | undefined, final: boolean): Shown | null {
    if (line === undefined) return final ? 'call' : null;
    return houseMessage(line) === null ? 'call' : 'message';
  }

  protected produced(_call: Call): Event[] {
    return [];
  }

  protected abstract decide(call: Call, final: boolean): Shown | null;

  protected abstract callOf(call: Call): Placed;

  protected abstract subagentOf(call: Call): Subagent;
}

interface Answered {
  result: Fields;
  content: unknown;
  at: number;
}

class ClaudeReader extends Reader {
  protected override readonly watchedOptions: Record<string, NoticeKind> = { model: 'model' };
  private readonly figures = new Map<string, Partial<Subagent>>();
  private readonly answers = new Map<string, Answered>();
  private readonly asked = new Map<string, number>();
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
    if (typeof sdk.tool_use_id !== 'string') return [];
    switch (sdk.subtype) {
      case 'task_started':
        return typeof sdk.subagent_type === 'string' ? this.figured(sdk.tool_use_id, { name: sdk.subagent_type }) : [];
      case 'task_progress':
        return this.figured(sdk.tool_use_id, { step: typeof sdk.description === 'string' ? sdk.description : null, ...this.usage(sdk.usage) });
      case 'task_notification':
        return this.figured(sdk.tool_use_id, {
          status: ENDED[sdk.status] ?? 'done',
          ...(typeof sdk.summary === 'string' ? { report: sdk.summary } : {}),
          ...this.usage(sdk.usage),
        });
      default:
        return [];
    }
  }

  private usage(usage: Fields | undefined): Partial<Subagent> {
    if (usage === undefined) return {};
    return { tokens: count(usage.total_tokens), calls: count(usage.tool_uses), duration: count(usage.duration_ms) };
  }

  private figured(key: string, figures: Partial<Subagent>): Event[] {
    const held = this.calls.get(key);
    if (held?.shown !== 'subagent' && held !== undefined) return [];
    this.figures.set(key, { ...this.figures.get(key), ...figures });
    return held === undefined ? [] : this.shown(held);
  }

  private assistant(sdk: Fields): Event[] {
    const at = Date.parse(sdk.timestamp);
    const events: Event[] = [];
    const usage = sdk.context_usage as Fields | undefined;
    if (usage !== undefined) {
      this.breakdown = (usage.categories as Fields[]).map((category) => ({ name: category.name, tokens: category.tokens }));
      events.push({ kind: 'state', state: { context: { used: usage.total_tokens, window: usage.raw_max_tokens, breakdown: this.breakdown } } });
    }
    const parent = sdk.parent_tool_use_id as string | null;
    for (const block of (sdk.message?.content ?? []) as Fields[]) {
      if (block.type === 'tool_use' && !Number.isNaN(at)) this.asked.set(block.id, at);
      if (parent === null) continue;
      if (block.type === 'text') events.push({ kind: 'text', id: sdk.message.id ?? null, parent, text: block.text });
      if (block.type === 'thinking') events.push({ kind: 'reasoning', id: sdk.message.id ?? null, parent, text: block.thinking });
    }
    return events;
  }

  private user(sdk: Fields): Event[] {
    const content = sdk.message?.content;
    if (!Array.isArray(content)) return [];
    const events: Event[] = [];
    for (const block of content as Fields[]) {
      if (block.type !== 'tool_result') continue;
      this.answers.set(block.tool_use_id, { result: (sdk.tool_use_result ?? {}) as Fields, content: block.content, at: Date.parse(sdk.timestamp) });
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

  protected override decide(held: Call, final: boolean): Shown | null {
    const tool = this.toolName(held);
    if (tool === 'Agent' || tool === 'Task' || held.meta.jetbrains?.air?.subagent === true) {
      return held.rawInput?.description === undefined && !final ? null : 'subagent';
    }
    if (tool === 'Bash') return this.decideLine(lineOf(held.rawInput?.command), final);
    return 'call';
  }

  protected override subagentOf(held: Call): Subagent {
    const answered = this.answers.get(held.id)?.result;
    const launched = held.meta.claudeCode?.toolResponse?.isAsync === true || answered?.status === 'async_launched';
    const reported = (Array.isArray(answered?.content) ? (answered.content as Fields[]) : []).filter((block) => block.type === 'text').at(-1)?.text;
    const finished: Partial<Subagent> =
      launched || (!FINISHED.has(held.status) && answered === undefined)
        ? {}
        : {
            status: held.status === 'failed' ? 'failed' : 'done',
            report: reported ?? (contentText(held.content) || null),
            tokens: count(answered?.totalTokens),
            calls: count(answered?.totalToolUseCount),
            duration: count(answered?.totalDurationMs),
          };
    return { ...startedAgent(held.rawInput?.description ?? held.title ?? '', held.rawInput?.subagent_type ?? null), ...finished, ...this.figures.get(held.id) };
  }

  protected override callOf(held: Call): Placed {
    const tool = this.toolName(held);
    const title = held.title ?? tool;
    const answered = this.answers.get(held.id);
    const result = answered?.result ?? {};
    const output = contentText(held.content) || blocksText(answered?.content);
    const asked = this.asked.get(held.id);
    const took = answered === undefined || asked === undefined || Number.isNaN(answered.at) ? null : Math.max(0, answered.at - asked);
    if (tool.startsWith('mcp__')) return call(held, title, { kind: 'tool', output }, took);
    switch (tool) {
      case 'Bash':
        return call(held, lineOf(held.rawInput?.command) ?? title, { kind: 'command' }, took);
      case 'Read':
        return call(held, title, { kind: 'read', returned: count(result.file?.numLines) }, took);
      case 'Grep':
      case 'Glob':
        return call(held, title, { kind: 'search', returned: count(result.numLines) ?? count(result.numFiles) }, took);
      case 'WebSearch': {
        const found = Array.isArray(result.results) ? (result.results as Fields[]).flatMap((entry) => (Array.isArray(entry?.content) ? entry.content : [])).length : null;
        return call(held, title, { kind: 'search', returned: found }, typeof result.durationSeconds === 'number' ? Math.round(result.durationSeconds * 1000) : took);
      }
      case 'WebFetch':
        return call(held, title, { kind: 'fetch', output: typeof result.result === 'string' ? result.result : output }, count(result.durationMs) ?? took);
    }
    if (held.kind === 'edit') return call(held, title, { kind: 'edit', files: this.claudeFiles(held, result) }, took);
    if (held.kind === 'read' || held.kind === 'search') return call(held, title, { kind: held.kind, returned: null }, took);
    if (held.kind === 'fetch') return call(held, title, { kind: 'fetch', output }, took);
    return call(held, title, { kind: 'other', output }, took);
  }

  private claudeFiles(held: Call, result: Fields): FileChange[] {
    const path = result.filePath ?? held.rawInput?.file_path;
    if (typeof path !== 'string') return [];
    if (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0) return [fileChange(path, hunks(result.structuredPatch))];
    if (result.type === 'create' && typeof result.content === 'string') return [wholeFile(path, '+', result.content)];
    return [];
  }

  protected override produced(held: Call): Event[] {
    if (held.status !== 'completed') return [];
    const tool = this.toolName(held);
    const result = this.answers.get(held.id)?.result ?? {};
    if (tool === 'CronCreate' && typeof result.id === 'string' && !this.crons.has(result.id)) {
      this.crons.set(result.id, held.id);
      const next = typeof result.nextFireAt === 'number' ? instant(result.nextFireAt) : null;
      return this.background(held.id, 'schedule', held.rawInput?.prompt ?? held.title ?? '', 'running', next);
    }
    if (tool === 'CronDelete' && typeof held.rawInput?.id === 'string' && this.crons.has(held.rawInput.id)) {
      const created = this.crons.get(held.rawInput.id)!;
      this.crons.delete(held.rawInput.id);
      return this.background(created, 'schedule', null, 'stopped');
    }
    if (tool !== 'ScheduleWakeup' || this.wakeups.has(held.id)) return [];
    if (held.rawInput?.stop === true) {
      const stopped = [...this.wakeups.keys()];
      this.wakeups.clear();
      return stopped.flatMap((id) => this.background(id, 'schedule', null, 'stopped'));
    }
    const seconds = WAKEUP.exec(contentText(held.content))?.[1];
    if (seconds === undefined) return [];
    const next = Date.now() + Number(seconds) * 1000;
    this.wakeups.set(held.id, next);
    return this.background(held.id, 'schedule', held.rawInput?.prompt ?? held.rawInput?.reason ?? held.title ?? '', 'running', instant(next));
  }
}

class CodexReader extends Reader {
  protected override readonly watchedOptions: Record<string, NoticeKind> = { mode: 'mode', collaboration_mode: 'mode' };
  private readonly children = new Map<string, { id: string | null; text: string }>();
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
      case 'subagent_spawned':
        this.children.set(update.subagentSessionId, { id: null, text: '' });
        return this.subagent(update.subagentSessionId, parent, startedAgent(update.name));
      case 'subagent_state_update': {
        const held = this.subagents.get(update.subagentSessionId);
        if (held === undefined) return [];
        const report = this.children.get(update.subagentSessionId)?.text || null;
        return this.subagent(update.subagentSessionId, parent, { ...held, status: ENDED[update.state] ?? 'failed', report });
      }
      default:
        return super.update(update, parent);
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
    if (update.sessionUpdate === 'subagent_spawned' || update.sessionUpdate === 'subagent_state_update') return this.update(update, session);
    if (!CHILD_UPDATES.has(update.sessionUpdate)) return [];
    const events = this.update(update, session);
    const step = events.findLast((event) => event.kind === 'part' && event.part.type === 'call');
    const held = this.subagents.get(session);
    if (step?.kind !== 'part' || step.part.type !== 'call' || held === undefined || held.step === step.part.line) return events;
    return [...events, ...this.subagent(session, null, { ...held, step: step.part.line })];
  }

  protected override decide(held: Call): Shown | null {
    if (held.kind === 'execute' && held.meta.is_mcp_tool_call !== true) return this.decideLine(lineOf(held.rawInput?.command) ?? held.title, true);
    return 'call';
  }

  protected override subagentOf(held: Call): Subagent {
    return startedAgent(held.title ?? '');
  }

  protected override callOf(held: Call): Placed {
    const item = this.items.get(held.id);
    const title = held.title ?? '';
    const took = count(item?.durationMs) ?? (count(item?.startedAtMs) !== null && count(item?.completedAtMs) !== null ? item!.completedAtMs - item!.startedAtMs : null);
    if (held.meta.is_mcp_tool_call === true) {
      return call(held, title, { kind: 'tool', output: blocksText(held.rawOutput?.result?.content) || contentText(held.content) }, took);
    }
    switch (held.kind) {
      case 'execute':
        return call(held, lineOf(held.rawInput?.command) ?? title, { kind: 'command' }, took);
      case 'read':
        return call(held, title, { kind: 'read', returned: typeof item?.aggregatedOutput === 'string' ? lineCount(item.aggregatedOutput) : null }, took);
      case 'search':
        return call(held, title, this.searched(held, item), took);
      case 'edit':
        return call(held, title, { kind: 'edit', files: this.codexFiles(item) }, took);
      default:
        return call(held, title, { kind: 'other', output: contentText(held.content) }, took);
    }
  }

  private searched(held: Call, item: Fields | undefined): Detail {
    if (item?.type !== 'webSearch') return { kind: 'search', returned: typeof held.rawOutput === 'string' ? lineCount(held.rawOutput) : null };
    const results = Array.isArray(item.results) ? (item.results as Fields[]) : null;
    if (item.action?.type === 'openPage' || item.action?.type === 'findInPage') {
      return { kind: 'fetch', output: (results ?? []).map((found) => found.snippet ?? found.title ?? '').join('\n') };
    }
    return { kind: 'search', returned: results === null ? null : results.length };
  }

  private codexFiles(item: Fields | undefined): FileChange[] {
    if (item?.type !== 'fileChange') return [];
    return (item.changes as Fields[]).map((change) => {
      if (change.kind?.type === 'add') return wholeFile(change.path, '+', change.diff);
      if (change.kind?.type === 'delete') return wholeFile(change.path, '-', change.diff);
      return fileChange(change.kind?.move_path ?? change.path, change.diff);
    });
  }

  protected override produced(held: Call): Event[] {
    if (held.imaged || held.kind === 'read') return [];
    const image = (held.content ?? []).find((entry) => entry.type === 'content' && entry.content?.type === 'image');
    if (image === undefined) return [];
    held.imaged = true;
    return [{ kind: 'image', data: image.content.data, mediaType: image.content.mimeType, parent: held.parent }];
  }
}

class GrokReader extends Reader {
  protected override readonly watchedOptions: Record<string, NoticeKind> = {};
  private readonly children = new Map<string, string | null>();
  private readonly figures = new Map<string, Partial<Subagent>>();
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
        return [...this.handedOff(update!.tool_call_id), ...this.background(update!.task_id, 'shell', update!.description ?? update!.command ?? '', 'running')];
      case '_x.ai/task_completed': {
        const snapshot = update!.task_snapshot as Fields;
        return this.background(snapshot.task_id, 'shell', null, snapshot.exit_code === 0 ? 'done' : 'failed');
      }
      case '_x.ai/scheduled_task_created': {
        this.schedules.add(update!.task_id);
        const next = Date.parse(update!.next_fire_at);
        return this.background(update!.task_id, 'schedule', update!.prompt ?? '', 'running', Number.isNaN(next) ? null : instant(next));
      }
      case '_x.ai/scheduled_task_deleted':
        return this.schedules.delete(update!.task_id) ? this.background(update!.task_id, 'schedule', null, 'stopped') : [];
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
        const unlinked = [...this.calls.values()].filter((candidate) => candidate.shown === 'subagent' && !linked.includes(candidate.id));
        const held = unlinked.find((candidate) => candidate.rawInput?.description === update.description) ?? unlinked[0];
        this.children.set(update.child_session_id, held?.id ?? null);
        return held === undefined ? [] : this.figured(held.id, { name: update.subagent_type ?? null });
      }
      case 'subagent_progress': {
        const key = this.children.get(update.child_session_id);
        return typeof key === 'string' ? this.figured(key, { tokens: count(update.tokens_used), calls: count(update.tool_call_count), duration: count(update.duration_ms) }) : [];
      }
      case 'subagent_finished': {
        const key = this.children.get(update.child_session_id);
        if (typeof key !== 'string') return [];
        return this.figured(key, {
          status: ENDED[update.status] ?? 'failed',
          report: update.output ?? null,
          tokens: count(update.tokens_used),
          calls: count(update.tool_calls),
          duration: count(update.duration_ms),
        });
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

  private figured(key: string, figures: Partial<Subagent>): Event[] {
    this.figures.set(key, { ...this.figures.get(key), ...figures });
    const held = this.calls.get(key);
    return held === undefined ? [] : this.shown(held);
  }

  private xai(held: Call): Fields {
    return (held.meta['x.ai/tool'] ?? {}) as Fields;
  }

  protected override decide(held: Call): Shown | null {
    const tool = this.xai(held);
    if (tool.name === 'spawn_subagent' || tool.kind === 'task') return 'subagent';
    if (tool.name === 'run_terminal_command') return this.decideLine(lineOf(held.rawInput?.command), true);
    return 'call';
  }

  protected override subagentOf(held: Call): Subagent {
    return { ...startedAgent(held.rawInput?.description ?? held.title ?? ''), ...this.figures.get(held.id) };
  }

  protected override callOf(held: Call): Placed {
    const tool = this.xai(held);
    const title = held.title ?? tool.name ?? '';
    const output = contentText(held.content);
    switch (tool.kind ?? held.kind) {
      case 'execute': {
        const exit = typeof held.rawOutput?.exit_code === 'number' && FINISHED.has(held.status) ? held.rawOutput.exit_code : null;
        return call({ status: held.status, exit, output: lastLines(output) }, lineOf(held.rawInput?.command) ?? title, { kind: 'command' });
      }
      case 'read':
        return call(held, title, { kind: 'read', returned: count(held.rawOutput?.FileContent?.total_lines) });
      case 'search':
        return call(held, title, { kind: 'search', returned: null });
      case 'write':
      case 'edit': {
        const diffs = (held.content ?? []).filter((entry) => entry.type === 'diff');
        return call(held, title, { kind: 'edit', files: diffs.map(replaced) });
      }
      case 'fetch':
        return call(held, title, { kind: 'fetch', output });
      default:
        return call(held, title, { kind: 'other', output });
    }
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
