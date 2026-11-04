import { applied, type Operation, type Part } from '@agentshouse/session-content';

type Unparented<P> = P extends Part ? Omit<P, 'parent'> : never;

export type Placed = Unparented<Part>;

export type PlanEntry = Extract<Part, { type: 'plan' }>['entries'][number];

interface Writing {
  type: 'text' | 'reasoning';
  id: string | null;
  index: number;
}

function whole(part: Placed, parent: number | null): Part {
  return { ...part, parent } as Part;
}

export class Content {
  parts: readonly Part[] = [];
  private readonly emit: (operation: Operation) => void;
  private readonly keys = new Map<string, number>();
  private readonly writing = new Map<number | null, Writing>();
  private planned: number | null = null;

  constructor(emit: (operation: Operation) => void) {
    this.emit = emit;
  }

  index(key: string): number | undefined {
    return this.keys.get(key);
  }

  write(type: 'text' | 'reasoning', id: string | null, parent: number | null, text: string): void {
    if (text === '') return;
    const writing = this.writing.get(parent);
    if (writing?.type === type && writing.id === id) {
      this.apply({ op: 'append', index: writing.index, text });
      return;
    }
    const index = this.add(parent, { type, text });
    this.writing.set(parent, { type, id, index });
  }

  put(key: string, parent: number | null, part: Placed): number {
    const index = this.keys.get(key);
    if (index === undefined) {
      const added = this.add(parent, part);
      this.keys.set(key, added);
      return added;
    }
    const changed = whole(part, this.parts[index]!.parent);
    if (JSON.stringify(changed) !== JSON.stringify(this.parts[index])) this.apply({ op: 'set', index, part: changed });
    return index;
  }

  plan(entries: PlanEntry[]): void {
    if (this.planned === null) {
      this.planned = this.add(null, { type: 'plan', entries });
      return;
    }
    this.apply({ op: 'set', index: this.planned, part: { type: 'plan', parent: null, entries } });
  }

  add(parent: number | null, part: Placed): number {
    this.writing.delete(parent);
    return this.arrived(parent, part);
  }

  arrived(parent: number | null, part: Placed): number {
    const index = this.parts.length;
    this.apply({ op: 'start', index, part: whole(part, parent) });
    return index;
  }

  operations(): Operation[] {
    return this.parts.map((part, index) => ({ op: 'start', index, part }));
  }

  private apply(operation: Operation): void {
    this.parts = applied(this.parts, operation)!;
    this.emit(operation);
  }
}
