import {
  client,
  type ContentBlock,
  type PlanEntry,
  type SessionConfigOption,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startAdapter, type Adapter } from './acp.ts';
import type { Agents, Route } from './agents.ts';
import type { House } from './api.ts';
import { blocksOf, firstChange, type Block } from './blocks.ts';
import type { Frame } from './stream.ts';

export interface Kit {
  house: House;
  agents: Agents;
  send(frame: Frame): boolean;
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
  quiet: NodeJS.Timeout | undefined;
  ready: Promise<void>;

  constructor(ready: (turn: Turn) => Promise<void>) {
    this.ready = ready(this);
  }
}

interface Running {
  adapter: Adapter;
  sessionId: string;
  options: SessionConfigOption[];
}

class Conversation {
  readonly id: string;
  running: Running | null = null;
  turn: Turn | null = null;
  queue: Promise<unknown> = Promise.resolve();

  constructor(id: string) {
    this.id = id;
  }
}

export class Conversations {
  private readonly kit: Kit;
  private readonly conversations = new Map<string, Conversation>();
  private readonly acks = new Map<string, Promise<Ack>>();

  constructor(kit: Kit) {
    this.kit = kit;
  }

  input(input: Input): void {
    const carried =
      this.acks.get(input.input_id) ??
      (() => {
        const conversation = this.conversation(input.conversation_id);
        const work = conversation.queue.then(() => this.carry(conversation, input));
        conversation.queue = work.catch(() => undefined);
        this.acks.set(input.input_id, work);
        return work;
      })();
    carried
      .then((body) => this.kit.house.deliver(`/kit/inputs/${input.input_id}/ack`, body))
      .catch(logged);
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
    return {};
  }

  private async open(conversation: Conversation, input: Input): Promise<Ack> {
    if (conversation.running !== null) return {};
    try {
      return { provider_session_id: await this.start(conversation, input.agent_id, null) };
    } catch (error) {
      return { refused: causeOf(error) };
    }
  }

  private async message(conversation: Conversation, input: Input): Promise<Ack> {
    let ack: Ack = {};
    if (conversation.running === null) {
      try {
        const opened = await this.start(conversation, input.agent_id, input.provider_session_id);
        if (input.provider_session_id === null) ack = { provider_session_id: opened };
      } catch (error) {
        return { refused: causeOf(error) };
      }
    }
    await this.prompt(conversation, [{ type: 'text', text: String(input.text) }]);
    return ack;
  }

  private async start(conversation: Conversation, agentId: string, sessionId: string | null): Promise<string> {
    await this.kit.agents.ready;
    const route = this.kit.agents.route(agentId);
    if (route === undefined) throw new Error(`this Environment hosts no Agent ${agentId}`);
    if (route.working_directory === join(LAUNCH_BASE, route.agent_id)) {
      await mkdir(route.working_directory, { recursive: true });
    }
    const app = client({ name: '@agentshouse/kit' }).onNotification('session/update', ({ params }) =>
      this.update(conversation, params),
    );
    const adapter = await startAdapter(route.kind, route.working_directory, app);
    try {
      const agent = adapter.connection.agent;
      const cwd = route.working_directory;
      const opened =
        sessionId === null
          ? await agent.request('session/new', { cwd, mcpServers: [] })
          : { ...(await agent.request('session/resume', { sessionId, cwd, mcpServers: [] })), sessionId };
      const running: Running = { adapter, sessionId: opened.sessionId, options: opened.configOptions ?? [] };
      await this.launchSettings(running, route);
      conversation.running = running;
      this.kit.send({ type: 'process', conversation_id: conversation.id, running: true });
      void adapter.exited.then((cause) => this.exited(conversation, adapter, cause));
      return running.sessionId;
    } catch (error) {
      adapter.child.kill('SIGKILL');
      throw error;
    }
  }

  private async launchSettings(running: Running, route: Route): Promise<void> {
    const settings: [string, string | null][] = [
      ['model', route.model],
      ['thought_level', route.effort],
    ];
    for (const [category, value] of settings) {
      const option = running.options.find((candidate) => candidate.category === category);
      if (value === null || option === undefined) continue;
      const answered = await running.adapter.connection.agent.request('session/set_config_option', {
        sessionId: running.sessionId,
        configId: option.id,
        value,
      });
      running.options = answered.configOptions;
    }
  }

  private exited(conversation: Conversation, adapter: Adapter, cause: string): void {
    if (conversation.running?.adapter !== adapter) return;
    conversation.running = null;
    this.kit.send({ type: 'process', conversation_id: conversation.id, running: false });
    if (conversation.turn !== null) this.end(conversation, conversation.turn, { failed: cause });
  }

  private begin(conversation: Conversation): Turn {
    const turn = new Turn((started) =>
      this.kit.house
        .deliver(`/kit/conversations/${conversation.id}/turns/${started.id}/started`, {})
        .then(() => undefined, logged),
    );
    conversation.turn = turn;
    return turn;
  }

  private end(conversation: Conversation, turn: Turn, outcome: Outcome): void {
    if (conversation.turn !== turn) return;
    conversation.turn = null;
    clearTimeout(turn.quiet);
    void turn.ready
      .then(() => this.kit.house.deliver(`/kit/conversations/${conversation.id}/turns/${turn.id}/ended`, outcome))
      .catch(logged);
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
    if (turn.prompts === 0) {
      clearTimeout(turn.quiet);
      turn.quiet = setTimeout(() => this.end(conversation, turn, { text: turn.text }), CLI_TURN_QUIET_MS);
    }
    return turn;
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
    }
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
