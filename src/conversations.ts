import {
  client,
  type AvailableCommand,
  type ContentBlock,
  type CreateElicitationRequest,
  type PlanEntry,
  type SessionConfigOption,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { killTree, startAdapter, type Adapter, type JobUpdate } from './acp.ts';
import type { Agents, Route } from './agents.ts';
import type { House } from './api.ts';
import { blocksOf, firstChange, type Block } from './blocks.ts';
import { openBridge, type Bridge } from './bridge.ts';
import { placeFiles, type MessageFile } from './files.ts';
import { instructions } from './instructions.ts';
import { holdSecretInput, type Step } from './secret-input.ts';
import type { Frame } from './stream.ts';

export interface Kit {
  house: House;
  agents: Agents;
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

const CLI_TURN_QUIET_MS = 10_000;
const LAUNCH_BASE = '/agents/house';
const KILLED = 'the conversation was killed';
const RUNNING_JOB = new Set(['running', 'paused']);

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logged(error: unknown): void {
  process.stderr.write(`kit: ${causeOf(error)}\n`);
}

class Turn {
  readonly id = randomUUID();
  text = '';
  sent: Block[] = [];
  unsentFrom: number | null = null;
  draftSequence = 0;
  planSequence = 0;
  prompts = 0;
  questions = 0;
  secrets = 0;
  quiet: NodeJS.Timeout | undefined;
  ready: Promise<void>;

  constructor(ready: (turn: Turn) => Promise<void>) {
    this.ready = ready(this);
  }
}

interface Running {
  adapter: Adapter;
  bridge: Bridge;
  sessionId: string;
  killed: boolean;
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
  options: SessionConfigOption[] | null = null;
  readonly jobs = new Set<string>();
  queue: Promise<unknown> = Promise.resolve();

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

  constructor(kit: Kit) {
    this.kit = kit;
  }

  input(input: Input): void {
    const carried =
      this.acks.get(input.input_id) ??
      (() => {
        const conversation = this.conversation(input.conversation_id);
        this.carrying++;
        const work = conversation.queue
          .then(() => this.carry(conversation, input))
          .finally(() => this.carrying--);
        conversation.queue = work.catch(() => undefined);
        this.acks.set(input.input_id, work);
        return work;
      })();
    carried
      .then((body) => {
        this.kit.changed();
        return this.kit.house.deliver(`/kit/inputs/${input.input_id}/ack`, body);
      })
      .catch(logged);
  }

  idle(): boolean {
    if (this.carrying > 0) return false;
    for (const conversation of this.conversations.values()) {
      const turn = conversation.turn;
      if (conversation.jobs.size > 0) return false;
      if (turn !== null && (turn.questions === 0 || turn.secrets > 0)) return false;
    }
    return true;
  }

  replay(): void {
    for (const conversation of this.conversations.values()) {
      if (conversation.running === null) continue;
      this.kit.send({ type: 'process', conversation_id: conversation.id, running: true });
      if (conversation.commands !== null) this.commands(conversation, conversation.commands);
      if (conversation.options !== null) this.options(conversation, conversation.options);
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
    if (input.kind === 'kill') await this.kill(conversation);
    if (input.kind === 'option') await this.option(conversation, String(input.option), input.value);
    if (input.kind === 'answer') this.questions.get(String(input.interaction_id))?.answer(input.response);
    return {};
  }

  private async open(conversation: Conversation, input: Input): Promise<Ack> {
    if (conversation.running !== null) return {};
    try {
      return { provider_session_id: await this.start(conversation, await this.route(input.agent_id), null) };
    } catch (error) {
      return { refused: causeOf(error) };
    }
  }

  private async message(conversation: Conversation, input: Input): Promise<Ack> {
    let ack: Ack = {};
    const prompt: ContentBlock[] = [];
    try {
      const route = await this.route(input.agent_id);
      const paths = await placeFiles(this.kit.house, route.working_directory, input.files as MessageFile[]);
      if (conversation.running === null) {
        const opened = await this.start(conversation, route, input.provider_session_id);
        if (input.provider_session_id === null) ack = { provider_session_id: opened };
      }
      if (input.first === true) {
        prompt.push({ type: 'text', text: await instructions(conversation.running!.bridge, route.base_instructions) });
      }
      prompt.push({ type: 'text', text: String(input.text) });
      if (paths.length > 0) prompt.push({ type: 'text', text: paths.join('\n') });
    } catch (error) {
      return { refused: causeOf(error) };
    }
    await this.prompt(conversation, prompt);
    return ack;
  }

  private async interrupt(conversation: Conversation, turnId: string): Promise<void> {
    if (conversation.running === null || conversation.turn?.id !== turnId) return;
    await conversation.running.adapter.connection.agent.notify('session/cancel', {
      sessionId: conversation.running.sessionId,
    });
  }

  private async kill(conversation: Conversation): Promise<void> {
    const running = conversation.running;
    if (running === null) return;
    running.killed = true;
    killTree(running.adapter.child);
    await running.adapter.exited;
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

  private async route(agentId: string): Promise<Route> {
    await this.kit.agents.ready;
    const route = this.kit.agents.route(agentId);
    if (route === undefined) throw new Error(`this Environment hosts no Agent ${agentId}`);
    return route;
  }

  private async start(conversation: Conversation, route: Route, sessionId: string | null): Promise<string> {
    if (route.working_directory === join(LAUNCH_BASE, route.agent_id)) {
      await mkdir(route.working_directory, { recursive: true });
    }
    const app = client({ name: '@agentshouse/kit' })
      .onNotification('session/update', ({ params }) => this.update(conversation, params))
      .onRequest('session/request_permission', ({ params }) =>
        this.ask(conversation, 'session/request_permission', params, false),
      )
      .onRequest('elicitation/create', ({ params }) =>
        this.ask(conversation, 'elicitation/create', params, asksSecret(params)),
      );
    const bridge = await openBridge(this.kit.house, conversation.id);
    const adapter = await startAdapter(
      route.kind,
      route.working_directory,
      app,
      (update) => this.job(conversation, update),
      { ...process.env, ...bridge.env },
    ).catch((error: unknown) => {
      bridge.close();
      throw error;
    });
    void adapter.exited.then(() => bridge.close());
    try {
      const agent = adapter.connection.agent;
      const cwd = route.working_directory;
      const opened =
        sessionId === null
          ? await agent.request('session/new', { cwd, mcpServers: [] })
          : { ...(await agent.request('session/resume', { sessionId, cwd, mcpServers: [] })), sessionId };
      const running: Running = { adapter, bridge, sessionId: opened.sessionId, killed: false };
      const options = await this.launchSettings(running, route, opened.configOptions ?? []);
      conversation.running = running;
      this.kit.send({ type: 'process', conversation_id: conversation.id, running: true });
      if (conversation.commands !== null) this.commands(conversation, conversation.commands);
      this.options(conversation, options);
      void adapter.exited.then((cause) => this.exited(conversation, adapter, cause));
      return running.sessionId;
    } catch (error) {
      killTree(adapter.child);
      throw error;
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
      const option = options.find((candidate) => candidate.category === category);
      if (value === null || option === undefined) continue;
      const answered = await running.adapter.connection.agent.request('session/set_config_option', {
        sessionId: running.sessionId,
        configId: option.id,
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
    conversation.options = null;
    conversation.jobs.clear();
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
    conversation.options = options;
    if (conversation.running === null) return;
    this.kit.send({ type: 'options', conversation_id: conversation.id, options });
  }

  private begin(conversation: Conversation): Turn {
    const turn = new Turn((started) =>
      this.kit.house
        .deliver(`/kit/conversations/${conversation.id}/turns/${started.id}/started`, {})
        .then(() => undefined, logged),
    );
    conversation.turn = turn;
    this.kit.changed();
    return turn;
  }

  private end(conversation: Conversation, turn: Turn, outcome: Outcome): void {
    if (conversation.turn !== turn) return;
    conversation.turn = null;
    clearTimeout(turn.quiet);
    void turn.ready
      .then(() => this.kit.house.deliver(`/kit/conversations/${conversation.id}/turns/${turn.id}/ended`, outcome))
      .catch(logged);
    this.kit.changed();
  }

  private async prompt(conversation: Conversation, prompt: ContentBlock[]): Promise<void> {
    const running = conversation.running!;
    const turn = conversation.turn ?? this.begin(conversation);
    turn.prompts++;
    clearTimeout(turn.quiet);
    await turn.ready;
    running.adapter.connection.agent
      .request('session/prompt', { sessionId: running.sessionId, prompt })
      .then(
        () => this.settle(conversation, turn, { text: turn.text }),
        async (error: unknown) => {
          const adapter = running.adapter;
          const failed = adapter.connection.signal.aborted ? await adapter.exited : causeOf(error);
          this.settle(conversation, turn, { failed });
        },
      );
  }

  private settle(conversation: Conversation, turn: Turn, outcome: Outcome): void {
    turn.prompts--;
    if (turn.prompts === 0) this.end(conversation, turn, outcome);
  }

  private current(conversation: Conversation): Turn {
    const turn = conversation.turn ?? this.begin(conversation);
    this.quiet(conversation, turn);
    return turn;
  }

  private quiet(conversation: Conversation, turn: Turn): void {
    clearTimeout(turn.quiet);
    if (turn.prompts > 0 || turn.questions > 0) return;
    turn.quiet = setTimeout(() => this.end(conversation, turn, { text: turn.text }), CLI_TURN_QUIET_MS);
  }

  private async ask<Response>(
    conversation: Conversation,
    method: string,
    params: object,
    secret: boolean,
  ): Promise<Response> {
    const turn = conversation.turn ?? this.begin(conversation);
    const interactionId = randomUUID();
    turn.questions++;
    if (secret) turn.secrets++;
    clearTimeout(turn.quiet);
    this.kit.changed();
    try {
      const answered = new Promise<Response>((answer) => {
        this.questions.set(interactionId, { conversation, answer: (response) => answer(response as Response) });
      });
      await turn.ready;
      await this.kit.house.deliver(`/kit/conversations/${conversation.id}/turns/${turn.id}/interactions`, {
        interaction_id: interactionId,
        request: { method, params },
        secret,
      });
      if (secret) void this.holdSecret(interactionId, params as CreateElicitationRequest);
      return await answered;
    } finally {
      this.questions.delete(interactionId);
      turn.questions--;
      if (secret) turn.secrets--;
      if (conversation.turn === turn) this.quiet(conversation, turn);
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
      const turn = this.current(conversation);
      turn.text += update.content.text;
      void turn.ready.then(() => this.draft(conversation, turn));
    } else if (update.sessionUpdate === 'plan') {
      const turn = this.current(conversation);
      void turn.ready.then(() => this.plan(conversation, turn, update.entries));
    } else if (update.sessionUpdate === 'available_commands_update') {
      this.commands(conversation, update.availableCommands);
    } else if (update.sessionUpdate === 'config_option_update') {
      this.options(conversation, update.configOptions);
    }
  }

  private job(conversation: Conversation, update: JobUpdate): void {
    if (update.sessionUpdate === 'async_task_spawned') conversation.jobs.add(update.asyncTaskId);
    else if (update.sessionUpdate === 'async_task_state_update' && !RUNNING_JOB.has(update.state ?? '')) {
      conversation.jobs.delete(update.asyncTaskId);
    } else return;
    this.kit.changed();
  }

  private draft(conversation: Conversation, turn: Turn): void {
    const blocks = blocksOf(turn.text);
    const from = Math.min(firstChange(turn.sent, blocks), turn.unsentFrom ?? Infinity);
    if (from === blocks.length && blocks.length === turn.sent.length && turn.unsentFrom === null) return;
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

  private plan(conversation: Conversation, turn: Turn, entries: PlanEntry[]): void {
    const sent = this.kit.send({
      type: 'plan',
      conversation_id: conversation.id,
      turn_id: turn.id,
      sequence: turn.planSequence + 1,
      from: 0,
      steps: entries.map((entry) => ({ label: entry.content, priority: entry.priority, status: entry.status })),
    });
    if (sent) turn.planSequence++;
  }
}
