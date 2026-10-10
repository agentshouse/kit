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
  private writing: { type: 'text' | 'reasoning'; id: string | null } | null = null;
  private planned: number | null = null;

  constructor(emit: (operation: Operation) => void) {
    this.emit = emit;
  }

  write(type: 'text' | 'reasoning', id: string | null, text: string): void {
    if (text === '') return;
    const last = this.parts.length - 1;
    const part = this.parts[last];
    if (this.writing?.type === type && this.writing.id === id && part?.type === type) {
      part.text += text;
      this.emit({ op: 'append', index: last, text });
      return;
    }
    this.start({ type, text });
    this.writing = { type, id };
  }

  command(): void {
    const last = this.parts.length - 1;
    const part = this.parts[last];
    if (part?.type !== 'commands') {
      this.start({ type: 'commands', count: 1 });
      return;
    }
    part.count++;
    this.emit({ op: 'count', index: last, count: part.count });
  }

  start(part: Part): number {
    this.writing = null;
    this.parts.push(part);
    const index = this.parts.length - 1;
    this.emit({ op: 'start', index, part });
    return index;
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

  operations(): Operation[] {
    return [
      ...this.parts.map((part, index): Operation => ({ op: 'start', index, part })),
      ...(this.context === null ? [] : [{ op: 'context' as const, ...this.context }]),
    ];
  }
}
