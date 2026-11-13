import { applied, type Operation, type Part, type PartOf } from '@agentshouse/session-content';

export type Kind = 'command' | 'edit' | 'other';

export interface Lines {
  added: number;
  removed: number;
}

export interface FileLines extends Lines {
  path: string;
}

export interface Called {
  kind: Kind;
  files: readonly FileLines[];
  failed: boolean;
}

interface Counted {
  stretch: number;
  kind: Kind;
  files: Map<string, Lines>;
  failed: boolean;
}

interface Writing {
  id: string | null;
  index: number;
}

type Counts = { -readonly [Key in keyof PartOf<'counts'>]: PartOf<'counts'>[Key] };

function filesOf(files: readonly FileLines[]): Map<string, Lines> {
  const held = new Map<string, Lines>();
  for (const { path, added, removed } of files) {
    const before = held.get(path);
    held.set(path, { added: (before?.added ?? 0) + added, removed: (before?.removed ?? 0) + removed });
  }
  return held;
}

function none(): Counts {
  return { type: 'counts', commands: 0, edited: 0, other: 0, added: 0, removed: 0, failed: 0 };
}

export class Content {
  parts: readonly Part[] = [];
  private readonly emit: (operation: Operation) => void;
  private readonly calls = new Map<string, Counted>();
  private writing: Writing | null = null;
  private stretch: number | null = null;

  constructor(emit: (operation: Operation) => void) {
    this.emit = emit;
  }

  holds(key: string): boolean {
    return this.calls.has(key);
  }

  write(id: string | null, text: string): void {
    if (text === '') return;
    if (this.writing !== null && this.writing.id === id) {
      this.apply({ op: 'append', index: this.writing.index, text });
      return;
    }
    this.stretch = null;
    this.writing = { id, index: this.started({ type: 'text', text }) };
  }

  add(part: PartOf<'notice'>): void {
    this.writing = null;
    this.started(part);
  }

  arrived(part: PartOf<'image'> | PartOf<'notice'>): void {
    this.started(part);
  }

  call(key: string, parent: string | null, called: Called): void {
    const held = this.calls.get(key);
    if (held !== undefined) {
      held.files = filesOf(called.files);
      held.failed = called.failed;
      this.settle(this.tally());
      return;
    }
    if (parent !== null && !this.calls.has(parent)) return;
    if (parent === null) this.writing = null;
    const stretch = parent === null ? this.stretch : this.calls.get(parent)!.stretch;
    const at = stretch ?? this.parts.length;
    this.calls.set(key, { stretch: at, kind: called.kind, files: filesOf(called.files), failed: called.failed });
    const tallied = this.tally();
    if (stretch === null) this.stretch = this.started(tallied.get(at)!);
    this.settle(tallied);
  }

  operations(): Operation[] {
    return this.parts.map((part, index) => ({ op: 'start', index, part }));
  }

  private tally(): Map<number, Counts> {
    const stretches = new Map<number, Counts>();
    const first = new Set<string>();
    for (const call of this.calls.values()) {
      const counts = stretches.get(call.stretch) ?? none();
      stretches.set(call.stretch, counts);
      if (call.kind === 'command') counts.commands += 1;
      if (call.kind === 'other') counts.other += 1;
      if (call.failed) counts.failed += 1;
      if (call.kind !== 'edit') continue;
      if (call.files.size === 0) counts.edited += 1;
      for (const [path, lines] of call.files) {
        if (!first.has(path)) counts.edited += 1;
        first.add(path);
        counts.added += lines.added;
        counts.removed += lines.removed;
      }
    }
    return stretches;
  }

  private settle(tallied: ReadonlyMap<number, Counts>): void {
    for (const [index, counts] of tallied) {
      if (JSON.stringify(counts) !== JSON.stringify(this.parts[index])) this.apply({ op: 'set', index, part: counts });
    }
  }

  private started(part: Part): number {
    const index = this.parts.length;
    this.apply({ op: 'start', index, part });
    return index;
  }

  private apply(operation: Operation): void {
    this.parts = applied(this.parts, operation)!;
    this.emit(operation);
  }
}
