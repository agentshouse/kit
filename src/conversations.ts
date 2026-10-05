import {
  client,
  type AvailableCommand,
  type ContentBlock,
  type ContentChunk,
  type CreateElicitationRequest,
  type PlanEntry,
  type SessionConfigOption,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { killMarked, startAdapter, TURN_ENDED, TURN_STARTED, type Adapter } from './acp.ts';
import type { Agents, Route } from './agents.ts';
import type { House } from './api.ts';
import { blocksOf, firstChange, type Block } from './blocks.ts';
import { openBridge, type Bridge } from './bridge.ts';
import { CLIS, type Cli, type Job, type Phase } from './clis.ts';
import type { WorkingCopies } from './copies.ts';
import { placeFiles, type MessageFile } from './files.ts';
import { agentBase } from './home.ts';
import { instructions } from './instructions.ts';
import { holdSecretInput, type Step } from './secret-input.ts';
import { createHowWeWork } from './skills.ts';
import type { Frame } from './stream.ts';

export interface Kit {
  house: House;
  agents: Agents;
  copies: WorkingCopies;
  send(frame: Frame): boolean;
  changed(): void;
}

export interface Input {
  input_id: string;
  kind: string;
  conversation_id: string;
  agent_id: string;
  provider_session_id: string | null;
  [field: string]: unknown;
}

type Ack = { provider_session_id: string } | { refused: string } | Record<string, never>;
type Outcome = { text: string } | { failed: string };

const KILLED = 'the conversation was killed';

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function answerMessage(request: unknown, response: unknown): string {
  return `The User answered a question you asked earlier.\nQuestion: ${JSON.stringify(request)}\nAnswer: ${JSON.stringify(response)}`;
}

function logged(error: unknown): void {
  process.stderr.write(`kit: ${causeOf(error)}\n`);
}

function unlessKilled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const killed = () => reject(signal.reason);
    signal.addEventListener('abort', killed, { once: true });
    if (signal.aborted) killed();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', killed));
  });
}

function stop(bridge: Bridge): void {
  killMarked(`HOUSE_BRIDGE=${bridge.env.HOUSE_BRIDGE}`);
}

interface Segment {
  messageId: string | null;
  phase: Phase | null;
  text: string;
}

class Turn {
  readonly id = randomUUID();
  text = '';
  segment: Segment | null = null;
  admitted = false;
  readonly notes: Frame[] = [];
  sent: Block[] = [];
  unsentFrom: number | null = null;
  draftSequence = 0;
  planSequence = 0;
  entries: PlanEntry[] | null = null;
  questions = 0;
  secrets = 0;
  prompt: Sent | null = null;
  ended = false;
}

interface Sent {
  turn: Turn | null;
}

interface Running {
  adapter: Adapter;
  bridge: Bridge;
  sessionId: string;
  killed: boolean;
  queues: boolean;
  phase: Cli['phase'];
}

interface Question {
  conversation: Conversation;
  answer(response: unknown): void;
}

class Conversation {
  readonly id: string;
  running: Running | null = null;
  turn: Turn | null = null;
  commands: AvailableCommand[] | null = null;
  readonly jobs = new Set<string>();
  readonly queued: Sent[] = [];
  readonly late: string[] = [];
  opening: Bridge | null = null;
  kills = 0;
  killed = new AbortController();
  open = 0;
  queue: Promise<unknown> = Promise.resolve();
  reports: Promise<unknown> = Promise.resolve();

  constructor(id: string) {
    this.id = id;
  }
}

interface FormProperty {
  title?: string;
  description?: string;
  _meta?: Record<string, unknown> | null;
}

function formProperties(request: CreateElicitationRequest): Record<string, FormProperty> {
  if (request.mode !== 'form') return {};
  return (request as { requestedSchema?: { properties?: Record<string, FormProperty> } }).requestedSchema?.properties ?? {};
}

function asksSecret(request: CreateElicitationRequest): boolean {
  return Object.values(formProperties(request)).some((property) =>
    Object.values(property._meta ?? {}).some(
      (meta) => typeof meta === 'object' && meta !== null && (meta as { isSecret?: unknown }).isSecret === true,
    ),
  );
}

export class Conversations {
  private readonly kit: Kit;
  private readonly conversations = new Map<string, Conversation>();
  private readonly acks = new Map<string, Promise<Ack>>();
  private readonly questions = new Map<string, Question>();
  private carrying = 0;
  private reporting = 0;

  constructor(kit: Kit) {
    this.kit = kit;
  }

  input(input: Input): void {
    this.carrying++;
    const carried =
      this.acks.get(input.input_id) ??
      (() => {
        const conversation = this.conversation(input.conversation_id);
        if (input.kind === 'kill') {
          conversation.kills++;
          conversation.killed.abort(new Error(KILLED));
          this.halt(conversation);
        }
        const work = conversation.queue.then(() => this.carry(conversation, input));
        conversation.queue = work.catch(() => undefined);
        this.acks.set(input.input_id, work);
        return work;
      })();
    carried
      .then((body) => this.kit.house.deliver(`/kit/inputs/${input.input_id}/ack`, body))
      .catch(logged)
      .finally(() => {
        this.carrying--;
        this.kit.changed();
      });
  }

  idle(): boolean {
    if (this.carrying > 0 || this.reporting > 0) return false;
    for (const conversation of this.conversations.values()) {
      const turn = conversation.turn;
      const asking = turn !== null && turn.questions > 0 && turn.secrets === 0;
      if (conversation.jobs.size > 0 || conversation.open > (asking ? 1 : 0)) return false;
    }
    return true;
  }

  opened(): void {
    for (const conversation of this.conversations.values()) {
      if (conversation.turn !== null) conversation.turn.unsentFrom = 0;
    }
  }

  private conversation(id: string): Conversation {
    let conversation = this.conversations.get(id);
    if (conversation === undefined) {
      conversation = new Conversation(id);
      this.conversations.set(id, conversation);
    }
    return conversation;
  }

  private async carry(conversation: Conversation, input: Input): Promise<Ack> {
    if (input.kind === 'open') return this.open(conversation, input);
    if (input.kind === 'message') return this.message(conversation, input);
    if (input.kind === 'interrupt') await this.interrupt(conversation, String(input.turn_id));
    if (input.kind === 'kill') {
      await this.kill(conversation);
      if (--conversation.kills === 0) conversation.killed = new AbortController();
    }
    if (input.kind === 'option') await this.option(conversation, String(input.option), input.value);
    if (input.kind === 'answer') {
      const question = this.questions.get(String(input.interaction_id));
      if (question === undefined) {
        return this.message(conversation, { ...input, text: answerMessage(input.request, input.response), files: [], first: false });
      }
      question.answer(input.response);
    }
    return {};
  }

  private async open(conversation: Conversation, input: Input): Promise<Ack> {
    if (conversation.running !== null) return {};
    try {
      return { provider_session_id: await this.start(conversation, await this.route(conversation, input.agent_id), null) };
    } catch (error) {
      return { refused: causeOf(error) };
    }
  }

  private async message(conversation: Conversation, input: Input): Promise<Ack> {
    let ack: Ack = {};
    const prompt: ContentBlock[] = [];
    try {
      const route = await this.route(conversation, input.agent_id);
      const paths = await placeFiles(
        this.kit.house,
        route.working_directory,
        input.files as MessageFile[],
        conversation.killed.signal,
      );
      if (conversation.running === null) {
        const opened = await this.start(conversation, route, input.provider_session_id);
        if (input.provider_session_id === null) ack = { provider_session_id: opened };
      }
      if (input.first === true) {
        prompt.push({
          type: 'text',
          text: await instructions(conversation.running!.bridge, route.base_instructions, await this.kit.copies.mapping()),
        });
      }
      prompt.push({ type: 'text', text: String(input.text) });
      if (paths.length > 0) prompt.push({ type: 'text', text: paths.join('\n') });
      if (conversation.kills > 0) throw new Error(KILLED);
    } catch (error) {
      if ('provider_session_id' in ack) await this.kill(conversation);
      return { refused: conversation.kills > 0 ? KILLED : causeOf(error) };
    }
    this.prompt(conversation, prompt);
    return ack;
  }

  private async interrupt(conversation: Conversation, turnId: string): Promise<void> {
    if (conversation.running === null || conversation.turn?.id !== turnId) return;
    await conversation.running.adapter.connection.agent.notify('session/cancel', {
      sessionId: conversation.running.sessionId,
    });
  }

  private halt(conversation: Conversation): void {
    if (conversation.opening !== null) stop(conversation.opening);
    if (conversation.running === null) return;
    conversation.running.killed = true;
    stop(conversation.running.bridge);
  }

  private async kill(conversation: Conversation): Promise<void> {
    const running = conversation.running;
    this.halt(conversation);
    await running?.adapter.exited;
  }

  private async option(conversation: Conversation, option: string, value: unknown): Promise<void> {
    const running = conversation.running;
    if (running === null) return;
    try {
      const answered = await running.adapter.connection.agent.request('session/set_config_option', {
        sessionId: running.sessionId,
        configId: option,
        ...(typeof value === 'boolean' ? { type: 'boolean' as const, value } : { value: String(value) }),
      });
      this.options(conversation, answered.configOptions);
    } catch (error) {
      logged(error);
    }
  }

  private async route(conversation: Conversation, agentId: string): Promise<Route> {
    const signal = conversation.killed.signal;
    await unlessKilled(this.kit.agents.read(), signal);
    if (this.kit.agents.route(agentId) === undefined) await unlessKilled(this.kit.agents.refresh(), signal);
    const route = this.kit.agents.route(agentId);
    if (route === undefined) throw new Error(`this Environment hosts no Agent ${agentId}`);
    if (route.working_directory === join(agentBase(), route.agent_id)) {
      await mkdir(route.working_directory, { recursive: true });
    }
    return route;
  }

  private async start(conversation: Conversation, route: Route, sessionId: string | null): Promise<string> {
    const app = client({ name: '@agentshouse/kit' })
      .onNotification('session/update', ({ params }) => this.update(conversation, params))
      .onNotification(TURN_STARTED, (params) => params, () => void this.started(conversation))
      .onNotification(TURN_ENDED, (params) => params, () => this.ended(conversation))
      .onRequest('session/request_permission', ({ params, signal }) =>
        this.ask(conversation, 'session/request_permission', params, false, signal),
      )
      .onRequest('elicitation/create', ({ params, signal }) =>
        this.ask(conversation, 'elicitation/create', params, asksSecret(params), signal),
      );
    const cli = await unlessKilled(this.kit.agents.cli(route.kind), conversation.killed.signal);
    const bridge = await openBridge(this.kit.house, this.kit.copies, conversation.id, conversation.killed.signal);
    if (conversation.kills > 0) {
      bridge.close();
      throw new Error(KILLED);
    }
    conversation.opening = bridge;
    try {
      await unlessKilled(createHowWeWork(bridge), conversation.killed.signal);
      const adapter = await startAdapter(
        route.kind,
        cli,
        route.working_directory,
        app,
        (job) => this.job(conversation, job),
        bridge.env,
      );
      void adapter.exited.then(() => bridge.close());
      const agent = adapter.connection.agent;
      const cwd = route.working_directory;
      const opened =
        sessionId === null
          ? await agent.request('session/new', { cwd, mcpServers: [] })
          : { ...(await agent.request('session/resume', { sessionId, cwd, mcpServers: [] })), sessionId };
      const running: Running = {
        adapter,
        bridge,
        sessionId: opened.sessionId,
        killed: false,
        queues: CLIS[route.kind]!.queues,
        phase: CLIS[route.kind]!.phase,
      };
      const options = await this.launchSettings(running, route, opened.configOptions ?? []);
      conversation.running = running;
      this.kit.send({ type: 'process', conversation_id: conversation.id, running: true });
      if (conversation.commands !== null) this.commands(conversation, conversation.commands);
      this.options(conversation, options);
      void adapter.exited.then((cause) => this.exited(conversation, adapter, cause));
      return running.sessionId;
    } catch (error) {
      stop(bridge);
      bridge.close();
      throw conversation.kills > 0 ? new Error(KILLED) : error;
    } finally {
      conversation.opening = null;
    }
  }

  private async launchSettings(
    running: Running,
    route: Route,
    offered: SessionConfigOption[],
  ): Promise<SessionConfigOption[]> {
    let options = offered;
    const settings: [string, string | null][] = [
      ['model', route.model],
      ['thought_level', route.effort],
    ];
    for (const [category, value] of settings) {
      if (value === null) continue;
      const option = options.find((candidate) => candidate.category === category);
      const answered = await running.adapter.connection.agent.request('session/set_config_option', {
        sessionId: running.sessionId,
        configId: option?.id ?? category,
        value,
      });
      options = answered.configOptions;
    }
    return options;
  }

  private exited(conversation: Conversation, adapter: Adapter, cause: string): void {
    const running = conversation.running;
    if (running?.adapter !== adapter) return;
    conversation.running = null;
    conversation.commands = null;
    conversation.jobs.clear();
    conversation.queued.length = 0;
    for (const [id, question] of this.questions) {
      if (question.conversation === conversation) this.questions.delete(id);
    }
    this.kit.send({ type: 'process', conversation_id: conversation.id, running: false });
    if (conversation.turn !== null) {
      this.end(conversation, conversation.turn, { failed: running.killed ? KILLED : cause });
    }
    this.kit.changed();
  }

  private commands(conversation: Conversation, commands: AvailableCommand[]): void {
    conversation.commands = commands;
    if (conversation.running === null) return;
    this.kit.send({ type: 'commands', conversation_id: conversation.id, commands });
  }

  private options(conversation: Conversation, options: SessionConfigOption[]): void {
    if (conversation.running === null) return;
    this.kit.send({ type: 'options', conversation_id: conversation.id, options });
  }

  private deliver(conversation: Conversation, turn: Turn, event: string, body: unknown): Promise<unknown> {
    this.reporting++;
    const delivered = conversation.reports.then(() =>
      this.kit.house.deliver(`/kit/conversations/${conversation.id}/turns/${turn.id}/${event}`, body),
    );
    conversation.reports = delivered
      .catch(() => undefined)
      .finally(() => {
        this.reporting--;
        this.kit.changed();
      });
    return delivered;
  }

  private report(conversation: Conversation): Turn {
    const turn = new Turn();
    conversation.open++;
    void this.deliver(conversation, turn, 'started', {})
      .then(() => this.admitted(conversation, turn))
      .catch(logged);
    return turn;
  }

  private admitted(conversation: Conversation, turn: Turn): void {
    turn.admitted = true;
    for (const note of turn.notes.splice(0)) this.kit.send(note);
    if (turn.text !== '') {
      turn.unsentFrom = 0;
      this.draft(conversation, turn);
    }
    if (turn.entries !== null) this.plan(conversation, turn);
  }

  private begin(conversation: Conversation): Turn {
    const turn = this.report(conversation);
    conversation.turn = turn;
    this.kit.changed();
    return turn;
  }

  private finish(conversation: Conversation, turn: Turn): void {
    if (turn.ended) return;
    const segment = turn.segment;
    turn.segment = null;
    if (segment?.phase === 'note') this.note(conversation, turn, segment.text);
    else if (segment !== null) this.answer(conversation, turn, segment.text);
    this.end(conversation, turn, { text: turn.text });
  }

  private end(conversation: Conversation, turn: Turn, outcome: Outcome): void {
    if (turn.ended) return;
    turn.ended = true;
    conversation.open--;
    if (conversation.turn === turn) conversation.turn = null;
    void this.deliver(conversation, turn, 'ended', outcome).catch(logged);
    const late = conversation.open === 0 ? conversation.late.shift() : undefined;
    if (late !== undefined) this.failed(conversation, late);
    this.kit.changed();
  }

  private failed(conversation: Conversation, cause: string): void {
    if (conversation.open > 0) conversation.late.push(cause);
    else this.end(conversation, this.report(conversation), { failed: cause });
  }

  private prompt(conversation: Conversation, prompt: ContentBlock[]): void {
    const running = conversation.running!;
    const sent: Sent = { turn: null };
    if (running.queues && (conversation.turn !== null || conversation.queued.length > 0)) {
      conversation.queued.push(sent);
    } else {
      this.attach(conversation.turn ?? this.begin(conversation), sent);
    }
    running.adapter.connection.agent.request('session/prompt', { sessionId: running.sessionId, prompt }).then(
      () => this.answered(conversation, sent, null),
      async (error: unknown) => {
        if (!running.adapter.connection.signal.aborted) this.answered(conversation, sent, causeOf(error));
        else if (sent.turn !== null) {
          this.end(conversation, sent.turn, { failed: running.killed ? KILLED : await running.adapter.exited });
        }
      },
    );
  }

  private attach(turn: Turn, sent: Sent): void {
    turn.prompt = sent;
    sent.turn = turn;
  }

  private answered(conversation: Conversation, sent: Sent, failed: string | null): void {
    const turn = sent.turn;
    if (turn === null) {
      const queued = conversation.queued.indexOf(sent);
      if (queued < 0) return;
      conversation.queued.splice(queued, 1);
      if (failed !== null) this.failed(conversation, failed);
    } else if (failed !== null) {
      if (turn.ended) this.failed(conversation, failed);
      else this.end(conversation, turn, { failed });
    } else if (turn.prompt === sent) {
      this.finish(conversation, turn);
    }
  }

  private started(conversation: Conversation): Turn {
    if (conversation.turn !== null) return conversation.turn;
    const turn = this.begin(conversation);
    const queued = conversation.queued.shift();
    if (queued !== undefined) this.attach(turn, queued);
    return turn;
  }

  private ended(conversation: Conversation): void {
    const turn = conversation.turn;
    if (turn === null) return;
    if (turn.prompt === null) {
      this.finish(conversation, turn);
    } else {
      conversation.turn = null;
      this.kit.changed();
    }
  }

  private async ask<Response>(
    conversation: Conversation,
    method: string,
    params: object,
    secret: boolean,
    signal: AbortSignal,
  ): Promise<Response> {
    const turn = this.started(conversation);
    const interactionId = randomUUID();
    const answered = new Promise<Response | null>((answer, fail) => {
      this.questions.set(interactionId, { conversation, answer: (response) => answer(response as Response) });
      signal.addEventListener('abort', () => answer(null), { once: true });
      this.deliver(conversation, turn, 'interactions', {
        interaction_id: interactionId,
        request: { method, params },
        secret,
      }).then(() => {
        if (secret) void this.holdSecret(interactionId, params as CreateElicitationRequest);
      }, fail);
    });
    turn.questions++;
    if (secret) turn.secrets++;
    this.kit.changed();
    try {
      const response = await answered;
      if (response === null) throw signal.reason;
      return response;
    } finally {
      this.questions.delete(interactionId);
      turn.questions--;
      if (secret) turn.secrets--;
      this.kit.changed();
    }
  }

  private async holdSecret(interactionId: string, request: CreateElicitationRequest): Promise<void> {
    const steps: Step[] = Object.entries(formProperties(request)).map(([name, property]) => ({
      kind: 'collect',
      label: property.title ?? name,
      name,
      ...(property.description ? { description: property.description } : {}),
    }));
    const content = await holdSecretInput(this.kit.house, interactionId, steps, () => this.questions.has(interactionId));
    if (content !== null) this.questions.get(interactionId)?.answer({ action: 'accept', content });
  }

  private update(conversation: Conversation, notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.chunk(conversation, this.started(conversation), update, update.content.text);
    } else if (update.sessionUpdate === 'plan') {
      const turn = this.started(conversation);
      this.close(conversation, turn);
      turn.entries = update.entries;
      this.plan(conversation, turn);
    } else if (update.sessionUpdate === 'tool_call') {
      this.close(conversation, this.started(conversation));
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      const turn = this.started(conversation);
      if (turn.segment?.messageId !== (update.messageId ?? null)) this.close(conversation, turn);
    } else if (update.sessionUpdate === 'available_commands_update') {
      this.commands(conversation, update.availableCommands);
    } else if (update.sessionUpdate === 'config_option_update') {
      this.options(conversation, update.configOptions);
    }
  }

  private job(conversation: Conversation, job: Job): void {
    if (job.running) conversation.jobs.add(job.id);
    else conversation.jobs.delete(job.id);
    this.kit.changed();
  }

  private chunk(conversation: Conversation, turn: Turn, chunk: ContentChunk, text: string): void {
    const phase = conversation.running?.phase(chunk) ?? null;
    const messageId = chunk.messageId ?? null;
    if (turn.segment?.messageId !== messageId || turn.segment.phase !== phase) this.close(conversation, turn);
    if (phase === 'answer') {
      this.answer(conversation, turn, text);
      return;
    }
    turn.segment ??= { messageId, phase, text: '' };
    turn.segment.text += text;
  }

  private close(conversation: Conversation, turn: Turn): void {
    const segment = turn.segment;
    if (segment === null) return;
    turn.segment = null;
    this.note(conversation, turn, segment.text);
  }

  private note(conversation: Conversation, turn: Turn, text: string): void {
    if (text.trim() === '') return;
    const note = { type: 'working-note', conversation_id: conversation.id, note_id: randomUUID(), text };
    if (turn.admitted) this.kit.send(note);
    else turn.notes.push(note);
  }

  private answer(conversation: Conversation, turn: Turn, text: string): void {
    turn.text += text;
    this.draft(conversation, turn);
  }

  private draft(conversation: Conversation, turn: Turn): void {
    const blocks = blocksOf(turn.text);
    const from = Math.min(firstChange(turn.sent, blocks), turn.unsentFrom ?? Infinity);
    const sent = this.kit.send({
      type: 'draft',
      conversation_id: conversation.id,
      turn_id: turn.id,
      sequence: turn.draftSequence + 1,
      from,
      blocks: blocks.slice(from),
    });
    if (sent) {
      turn.draftSequence++;
      turn.sent = blocks;
      turn.unsentFrom = null;
    } else {
      turn.unsentFrom = from;
    }
  }

  private plan(conversation: Conversation, turn: Turn): void {
    const sent = this.kit.send({
      type: 'plan',
      conversation_id: conversation.id,
      turn_id: turn.id,
      sequence: turn.planSequence + 1,
      from: 0,
      steps: turn.entries!.map((entry) => ({ label: entry.content, priority: entry.priority, status: entry.status })),
    });
    if (sent) turn.planSequence++;
  }
}
