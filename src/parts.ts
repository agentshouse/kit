export type Marker = 'mode' | 'compaction' | 'retry' | 'model' | 'job';

export interface PlanStep {
  content: string;
  status: string;
}

export interface Context {
  used: number;
  window: number;
}

export interface Subagent {
  type: 'subagent';
  description: string;
  status: 'running' | 'done';
  result: string | null;
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'commands'; count: number }
  | Subagent
  | { type: 'message'; command: string; target: string | null }
  | { type: 'image'; file: string; name: string; media_type: string }
  | { type: 'marker'; marker: Marker; text: string }
  | { type: 'plan'; entries: PlanStep[] };

export type Operation =
  | { op: 'start'; index: number; part: Part }
  | { op: 'append'; index: number; text: string }
  | { op: 'status'; index: number; status: 'done'; result: string | null }
  | { op: 'count'; index: number; count: number }
  | { op: 'plan'; index: number; entries: PlanStep[] }
  | { op: 'context'; used: number; window: number };

export class Parts {
  readonly parts: Part[] = [];
  context: Context | null = null;
  private readonly emit: (operation: Operation) => void;
  private readonly made: number[] = [];
  private events = 0;
  private writing: { type: 'text' | 'reasoning'; id: string | null; index: number } | null = null;
  private counting: number | null = null;
  private planned: number | null = null;

  constructor(emit: (operation: Operation) => void) {
    this.emit = emit;
  }

  write(type: 'text' | 'reasoning', id: string | null, text: string): void {
    if (text === '') return;
    if (this.writing?.type === type && this.writing.id === id) {
      (this.parts[this.writing.index] as { text: string }).text += text;
      this.emit({ op: 'append', index: this.writing.index, text });
      return;
    }
    this.writing = { type, id, index: this.start({ type, text }) };
  }

  command(): void {
    if (this.counting === null) {
      this.counting = this.start({ type: 'commands', count: 1 });
      return;
    }
    const part = this.parts[this.counting] as { count: number };
    part.count++;
    this.emit({ op: 'count', index: this.counting, count: part.count });
  }

  start(part: Part): number {
    this.writing = null;
    this.counting = null;
    return this.add(part, ++this.events);
  }

  reserve(): number {
    this.writing = null;
    this.counting = null;
    return ++this.events;
  }

  arrive(part: Part, reserved: number): void {
    this.add(part, reserved);
  }

  done(index: number, result: string | null): void {
    const part = this.parts[index] as Subagent;
    part.status = 'done';
    part.result = result;
    this.emit({ op: 'status', index, status: 'done', result });
  }

  plan(entries: PlanStep[]): void {
    if (this.planned === null) {
      this.planned = this.start({ type: 'plan', entries });
      return;
    }
    (this.parts[this.planned] as { entries: PlanStep[] }).entries = entries;
    this.emit({ op: 'plan', index: this.planned, entries });
  }

  measure(context: Context): void {
    this.context = context;
    this.emit({ op: 'context', ...context });
  }

  saved(): Part[] {
    return this.parts
      .map((part, index) => ({ part, made: this.made[index]! }))
      .sort((a, b) => a.made - b.made)
      .map(({ part }) => part);
  }

  operations(): Operation[] {
    return [
      ...this.parts.map((part, index): Operation => ({ op: 'start', index, part })),
      ...(this.context === null ? [] : [{ op: 'context' as const, ...this.context }]),
    ];
  }

  private add(part: Part, made: number): number {
    this.parts.push(part);
    this.made.push(made);
    const index = this.parts.length - 1;
    this.emit({ op: 'start', index, part });
    return index;
  }
}
