import {
  client,
  type AvailableCommand,
  type ContentBlock,
  type CreateElicitationRequest,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unlessAborted } from './abort.ts';
import { killMarked, processes, startAdapter, type Adapter } from './acp.ts';
import type { Agents, Route } from './agents.ts';
import type { House } from './api.ts';
import { openBridge, type Bridge } from './bridge.ts';
import { CLIS } from './clis.ts';
import type { LocalCopies } from './copies.ts';
import { readerFor, type Event, type Message, type Reader } from './events.ts';
import { placeFiles, uploadBytes, type MessageFile, type SavedFile } from './files.ts';
import { agentBase } from './home.ts';
import { instructions } from './instructions.ts';
import { Parts, type Context, type Operation, type Part } from './parts.ts';
import { holdSecretInput, type Step } from './secret-input.ts';
import { createHowWeWork } from './skills.ts';
import type { Frame } from './stream.ts';
import { transcribe } from './transcription.ts';

export interface Kit {
  house: House;
  agents: Agents;
  copies: LocalCopies;
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

const KILLED = 'the conversation was killed';
// A process a conversation left running reports nothing when it exits, so the Kit looks again every five seconds while one runs.
const PROCESS_RECHECK_MS = 5000;

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function answerMessage(request: unknown, response: unknown): string {
  return `The User answered a question you asked earlier.\nQuestion: ${JSON.stringify(request)}\nAnswer: ${JSON.stringify(response)}`;
}

function logged(error: unknown): void {
  process.stderr.write(`kit: ${causeOf(error)}\n`);
}

function marker(bridge: Bridge): string {
  return `HOUSE_BRIDGE=${bridge.env.HOUSE_BRIDGE}`;
}

function stop(bridge: Bridge): void {
  killMarked(marker(bridge));
}

class Turn {
  readonly id = randomUUID();
  readonly parts: Parts;
  admitted = false;
  questions = 0;
  secrets = 0;
  prompted = false;
  ended = false;
  images = 0;
  readonly uploads: Promise<unknown>[] = [];

  constructor(emit: (operation: Operation) => void) {
    this.parts = new Parts(emit);
  }
}

interface Running {
  adapter: Adapter;
  bridge: Bridge;
  sessionId: string;
  killed: boolean;
  reader: Reader;
  baseline: Set<string> | null;
}

interface Waiting {
  input: Input;
  route: Route;
  content: ContentBlock[];
  settle(ack: Ack): void;
}

interface Question {
  conversation: Conversation;
  answer(response: unknown): void;
}

class Conversation {
  readonly id: string;
  running: Running | null = null;
  session: string | null = null;
  turn: Turn | null = null;
  commands: AvailableCommand[] | null = null;
  context: Context | null = null;
  readonly busy = new Set<string>();
  readonly waiting: Waiting[] = [];
  sending: Promise<void> | null = null;
  readonly subagents = new Map<string, { description: string; turn: Turn; index: number }>();
  readonly held: Part[] = [];
  opening: Bridge | null = null;
  kills = 0;
  killed = new AbortController();
  interrupts = 0;
  interrupted = new AbortController();
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
  private watched = false;
  private recheck: NodeJS.Timeout | null = null;

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
          for (const waiting of conversation.waiting.splice(0)) waiting.settle({ refused: KILLED });
          this.halt(conversation);
        }
        if (input.kind === 'interrupt') {
          conversation.interrupts++;
          conversation.interrupted.abort();
        }
        const handled = conversation.queue.then(() => this.carry(conversation, input));
        conversation.queue = handled.catch(() => undefined);
        const work = handled.then(({ ack }) => ack);
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
      if (conversation.busy.size > 0 || conversation.open > (asking ? 1 : 0)) return false;
    }
    for (const conversation of this.conversations.values()) {
      const running = conversation.running;
      if (running === null || running.baseline === null) continue;
      if ([...processes(marker(running.bridge))].every((found) => running.baseline!.has(found))) continue;
      this.recheck ??= setTimeout(() => {
        this.recheck = null;
        this.kit.changed();
      }, PROCESS_RECHECK_MS);
      return false;
    }
    return true;
  }

  opened(): void {
    this.watched = false;
  }

  watching(watched: boolean): void {
    const resend = watched && !this.watched;
    this.watched = watched;
    if (!resend) return;
    for (const conversation of this.conversations.values()) {
      if (conversation.turn !== null) this.replay(conversation, conversation.turn);
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

  private async carry(conversation: Conversation, input: Input): Promise<{ ack: Promise<Ack> }> {
    if (input.kind === 'open') return { ack: Promise.resolve(await this.open(conversation, input)) };
    if (input.kind === 'message') return this.message(conversation, input);
    if (input.kind === 'interrupt') {
      if (--conversation.interrupts === 0) conversation.interrupted = new AbortController();
      await this.interrupt(conversation, String(input.turn_id));
    }
    if (input.kind === 'kill') {
      await this.kill(conversation);
      await conversation.sending;
      if (--conversation.kills === 0) conversation.killed = new AbortController();
    }
    if (input.kind === 'option') await this.option(conversation, String(input.option), input.value);
    if (input.kind === 'answer') {
      const question = this.questions.get(String(input.interaction_id));
      if (question === undefined) {
        const text = answerMessage(input.request, input.response);
        return this.message(conversation, { ...input, text, files: [], first: false });
      }
      question.answer(input.response);
    }
    return { ack: Promise.resolve({}) };
  }

  private async open(conversation: Conversation, input: Input): Promise<Ack> {
    if (conversation.running !== null) return {};
    try {
      return { provider_session_id: await this.start(conversation, await this.route(conversation, input.agent_id), null) };
    } catch (error) {
      return { refused: causeOf(error) };
    }
  }

  private async message(conversation: Conversation, input: Input): Promise<{ ack: Promise<Ack> }> {
    const content: ContentBlock[] = [{ type: 'text', text: String(input.text) }];
    let route: Route;
    try {
      route = await this.route(conversation, input.agent_id);
      const files = input.files as MessageFile[];
      const paths = await placeFiles(this.kit.house, route.working_directory, files, conversation.killed.signal);
      const lines = await this.transcribed(conversation, files, paths);
      if (lines.length > 0) content.push({ type: 'text', text: lines.join('\n') });
      if (conversation.kills > 0) throw new Error(KILLED);
    } catch (error) {
      return { ack: Promise.resolve({ refused: conversation.kills > 0 ? KILLED : causeOf(error) }) };
    }
    return {
      ack: new Promise<Ack>((settle) => {
        conversation.waiting.push({ input, route, content, settle });
        this.next(conversation);
      }),
    };
  }

  private next(conversation: Conversation): void {
    if (conversation.sending !== null || conversation.open > 0) return;
    const waiting = conversation.waiting.shift();
    if (waiting === undefined) return;
    conversation.sending = this.send(conversation, waiting).finally(() => {
      conversation.sending = null;
      this.next(conversation);
    });
  }

  private async send(conversation: Conversation, waiting: Waiting): Promise<void> {
    const { input } = waiting;
    let ack: Ack = {};
    const prompt: ContentBlock[] = [];
    try {
      if (conversation.running === null) {
        const resumed = input.provider_session_id ?? conversation.session;
        const opened = await this.start(conversation, waiting.route, resumed);
        if (resumed === null) ack = { provider_session_id: opened };
      }
      if (input.first === true) {
        prompt.push({
          type: 'text',
          text: await instructions(conversation.running!.bridge, waiting.route.base_instructions, await this.kit.copies.mapping()),
        });
      }
      if (conversation.kills > 0) throw new Error(KILLED);
    } catch (error) {
      if ('provider_session_id' in ack) {
        conversation.session = null;
        await this.kill(conversation);
      }
      waiting.settle({ refused: conversation.kills > 0 ? KILLED : causeOf(error) });
      return;
    }
    this.prompt(conversation, [...prompt, ...waiting.content]);
    waiting.settle(ack);
  }

  private async transcribed(conversation: Conversation, files: MessageFile[], paths: string[]): Promise<string[]> {
    const lines: string[] = [];
    for (const [index, path] of paths.entries()) {
      lines.push(path);
      if (files[index]!.media_type?.startsWith('audio/') !== true) continue;
      try {
        const text = await transcribe(path, AbortSignal.any([conversation.killed.signal, conversation.interrupted.signal]));
        if (text !== null && text !== '') lines.push(`Transcript: ${text}`);
      } catch (error) {
        if (conversation.kills > 0) throw error;
        logged(new Error(`${files[index]!.name} was not transcribed: ${causeOf(error)}`));
      }
    }
    return lines;
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
      running.reader.requested(option, value);
      const answered = await running.adapter.connection.agent.request('session/set_config_option', {
        sessionId: running.sessionId,
        configId: option,
        ...(typeof value === 'boolean' ? { type: 'boolean' as const, value } : { value: String(value) }),
      });
      this.options(conversation, answered.configOptions);
    } catch (error) {
      running.reader.refused(option);
      logged(error);
    }
  }

  private async route(conversation: Conversation, agentId: string): Promise<Route> {
    const signal = conversation.killed.signal;
    await unlessAborted(this.kit.agents.read(), signal);
    if (this.kit.agents.route(agentId) === undefined) await unlessAborted(this.kit.agents.refresh(), signal);
    const route = this.kit.agents.route(agentId);
    if (route === undefined) throw new Error(`this Environment hosts no Agent ${agentId}`);
    if (route.working_directory === join(agentBase(), route.agent_id)) {
      await mkdir(route.working_directory, { recursive: true });
    }
    return route;
  }

  private async start(conversation: Conversation, route: Route, sessionId: string | null): Promise<string> {
    const reader = readerFor(route.kind);
    reader.session = sessionId;
    const app = client({ name: '@agentshouse/kit' })
      .onRequest('session/request_permission', ({ params, signal }) =>
        this.ask(conversation, 'session/request_permission', params, false, signal),
      )
      .onRequest('elicitation/create', ({ params, signal }) =>
        this.ask(conversation, 'elicitation/create', params, asksSecret(params), signal),
      );
    const cli = await unlessAborted(this.kit.agents.cli(route.kind), conversation.killed.signal);
    const bridge = await openBridge(this.kit.house, this.kit.copies, conversation.id, conversation.killed.signal);
    if (conversation.kills > 0) {
      bridge.close();
      throw new Error(KILLED);
    }
    conversation.opening = bridge;
    try {
      await unlessAborted(createHowWeWork(bridge), conversation.killed.signal);
      await CLIS[route.kind]!.allowHouse();
      conversation.busy.clear();
      const adapter = await startAdapter(
        route.kind,
        cli,
        route.working_directory,
        app,
        (message) => this.read(conversation, reader, message),
        bridge.env,
      );
      void adapter.exited.then(() => bridge.close());
      const agent = adapter.connection.agent;
      const cwd = route.working_directory;
      const _meta = CLIS[route.kind]!.sessionMeta;
      const opened =
        sessionId === null
          ? await agent.request('session/new', { cwd, mcpServers: [], _meta })
          : { ...(await agent.request('session/resume', { sessionId, cwd, mcpServers: [], _meta })), sessionId };
      reader.session = opened.sessionId;
      const running: Running = { adapter, bridge, sessionId: opened.sessionId, killed: false, reader, baseline: null };
      const options = await this.launchSettings(running, route, opened.configOptions ?? []);
      running.baseline = processes(marker(bridge));
      conversation.running = running;
      conversation.session = running.sessionId;
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
      ['mode', route.mode ?? CLIS[route.kind]!.fullAccess],
      ['model', route.model],
      ['thought_level', route.effort],
    ];
    for (const [category, value] of settings) {
      if (value === null) continue;
      const option = options.find((candidate) => candidate.category === category);
      running.reader.requested(option?.id ?? category, value);
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
    this.detach(conversation);
    if (conversation.turn !== null) {
      this.end(conversation, conversation.turn, { failed: running.killed ? KILLED : cause });
    }
    this.next(conversation);
    this.kit.changed();
  }

  private detach(conversation: Conversation): void {
    conversation.running = null;
    conversation.commands = null;
    conversation.busy.clear();
    for (const [id, question] of this.questions) {
      if (question.conversation === conversation) this.questions.delete(id);
    }
    this.kit.send({ type: 'process', conversation_id: conversation.id, running: false });
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
    const delivered = conversation.reports.then(async () =>
      this.kit.house.deliver(`/kit/conversations/${conversation.id}/turns/${turn.id}/${event}`, await body),
    );
    conversation.reports = delivered
      .catch(() => undefined)
      .finally(() => {
        this.reporting--;
        this.kit.changed();
      });
    return delivered;
  }

  private write(conversation: Conversation, turn: Turn, operation: Operation): void {
    if (!turn.admitted || turn.ended || !this.watched) return;
    this.kit.send({ type: 'turn', conversation_id: conversation.id, turn_id: turn.id, ...operation });
  }

  private replay(conversation: Conversation, turn: Turn): void {
    for (const operation of turn.parts.operations()) this.write(conversation, turn, operation);
  }

  private begin(conversation: Conversation): Turn {
    const turn: Turn = new Turn((operation) => this.write(conversation, turn, operation));
    conversation.open++;
    void this.deliver(conversation, turn, 'started', {})
      .then(() => {
        turn.admitted = true;
        this.replay(conversation, turn);
      })
      .catch(logged);
    conversation.turn = turn;
    if (conversation.context !== null) turn.parts.measure(conversation.context);
    for (const part of conversation.held.splice(0)) turn.parts.start(part);
    for (const event of conversation.running?.reader.turnStarted() ?? []) this.event(conversation, event);
    this.kit.changed();
    return turn;
  }

  private end(conversation: Conversation, turn: Turn, failed: { failed: string } | null): void {
    if (turn.ended) return;
    if (conversation.turn === turn) {
      for (const event of conversation.running?.reader.closeTurn() ?? []) this.apply(conversation, turn, event);
    }
    turn.ended = true;
    conversation.open--;
    if (conversation.turn === turn) conversation.turn = null;
    const body = Promise.allSettled(turn.uploads).then(() => ({
      parts: turn.parts.parts,
      context: turn.parts.context,
      ...failed,
    }));
    void this.deliver(conversation, turn, 'ended', body).catch(logged);
    this.next(conversation);
    this.kit.changed();
  }

  private prompt(conversation: Conversation, prompt: ContentBlock[]): void {
    const running = conversation.running!;
    const turn = this.begin(conversation);
    turn.prompted = true;
    running.adapter.connection.agent.request('session/prompt', { sessionId: running.sessionId, prompt }).then(
      () => this.end(conversation, turn, null),
      async (error: unknown) => {
        if (running.adapter.connection.signal.aborted) {
          this.end(conversation, turn, { failed: running.killed ? KILLED : await running.adapter.exited });
        } else {
          if (conversation.open === 1 && conversation.running === running) {
            stop(running.bridge);
            this.detach(conversation);
          }
          this.end(conversation, turn, { failed: causeOf(error) });
        }
      },
    );
  }

  private started(conversation: Conversation): Turn {
    return conversation.turn ?? this.begin(conversation);
  }

  private ended(conversation: Conversation): void {
    const turn = conversation.turn;
    if (turn === null) return;
    if (!turn.prompted) {
      this.end(conversation, turn, null);
    } else {
      for (const event of conversation.running?.reader.closeTurn() ?? []) this.apply(conversation, turn, event);
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

  private read(conversation: Conversation, reader: Reader, message: Message): void {
    for (const event of reader.read(message)) this.event(conversation, event);
  }

  private event(conversation: Conversation, event: Event): void {
    switch (event.kind) {
      case 'started':
        this.started(conversation);
        return;
      case 'ended':
        this.ended(conversation);
        return;
      case 'commands':
        this.commands(conversation, event.commands);
        return;
      case 'options':
        this.options(conversation, event.options);
        return;
      case 'busy':
        if (event.running) conversation.busy.add(event.key);
        else conversation.busy.delete(event.key);
        this.kit.changed();
        return;
      case 'servers': {
        const running = conversation.running;
        if (running?.baseline) for (const found of processes(marker(running.bridge))) running.baseline.add(found);
        return;
      }
      case 'context':
        conversation.context = { used: event.used, window: event.window };
        conversation.turn?.parts.measure(conversation.context);
        return;
      case 'subagent-done':
        this.subagentDone(conversation, event.id, event.result);
        return;
      case 'marker':
      case 'image':
        if (conversation.turn !== null) break;
        if (event.kind === 'marker' && event.marker === 'job') conversation.held.push({ type: 'marker', marker: 'job', text: event.text });
        return;
    }
    this.apply(conversation, this.started(conversation), event);
  }

  private apply(conversation: Conversation, turn: Turn, event: Event): void {
    switch (event.kind) {
      case 'text':
      case 'reasoning':
        turn.parts.write(event.kind, event.id, event.text);
        return;
      case 'command':
        turn.parts.command();
        return;
      case 'subagent': {
        const index = turn.parts.start({ type: 'subagent', description: event.description, status: 'running', result: null });
        conversation.subagents.set(event.id, { description: event.description, turn, index });
        return;
      }
      case 'message':
        turn.parts.start({ type: 'message', command: event.command, target: event.target });
        return;
      case 'marker':
        turn.parts.start({ type: 'marker', marker: event.marker, text: event.text });
        return;
      case 'plan':
        turn.parts.plan(event.entries);
        return;
      case 'image':
        turn.uploads.push(this.image(conversation, turn, event.data, event.mediaType));
        this.kit.changed();
        return;
    }
  }

  private subagentDone(conversation: Conversation, id: string, result: string | null): void {
    const subagent = conversation.subagents.get(id);
    if (subagent === undefined) return;
    conversation.subagents.delete(id);
    if (subagent.turn === conversation.turn) {
      subagent.turn.parts.done(subagent.index, result);
      return;
    }
    const part: Part = { type: 'subagent', description: subagent.description, status: 'done', result };
    if (conversation.turn === null) conversation.held.push(part);
    else conversation.turn.parts.start(part);
  }

  private async image(conversation: Conversation, turn: Turn, data: string, mediaType: string): Promise<void> {
    const bytes = Buffer.from(data, 'base64');
    const name = `image-${++turn.images}.${mediaType.split('/')[1]}`;
    try {
      const declared = (await this.deliver(conversation, turn, 'images', {
        name,
        media_type: mediaType,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })) as SavedFile;
      const saved = declared.upload === undefined ? declared : await uploadBytes(declared.upload, bytes);
      if (saved.save.status !== 'saved') throw new Error(saved.save.failure ?? saved.save.status);
      turn.parts.start({ type: 'image', file: saved.version, name, media_type: mediaType });
    } catch (error) {
      turn.parts.start({ type: 'marker', marker: 'retry', text: `${name} was not saved: ${causeOf(error)}` });
    }
  }
}
