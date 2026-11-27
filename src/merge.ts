import {
  apply,
  bodyAfterFrontmatter,
  definitionAt,
  equalValue,
  escapePointer,
  HOUSE_ROOM_TYPES,
  HOUSE_TYPED_PATHS,
  parse,
  verifySchemaDocument,
  type Change,
  type Definition,
  type Document,
  type Extent,
  type VerifiedModel,
} from '@agentshouse/mdmodel';

const OPENING = '<<<<<<< current\n';
const BETWEEN = '=======\n';
const CLOSING = '>>>>>>> yours\n';

type Side = 'current' | 'yours';

type Clash = Record<Side, string[]>;

type Piece = string | Clash;

export interface Merged {
  text: string;
  settled: boolean;
}

export function whole(theirs: string, mine: string): string {
  return `${OPENING}${ended(theirs)}${BETWEEN}${ended(mine)}${CLOSING}`;
}

function ended(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

function lines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/u);
}

function pieces(merged: string): Piece[] {
  const read: Piece[] = [];
  let clash: Clash | null = null;
  let side: Side = 'current';
  for (const line of lines(merged)) {
    if (clash === null) {
      if (line !== OPENING) read.push(line);
      else [clash, side] = [{ current: [], yours: [] }, 'current'];
    } else if (side === 'current' && line === BETWEEN) side = 'yours';
    else if (side === 'yours' && line === CLOSING) {
      read.push(clash);
      clash = null;
    } else clash[side].push(line);
  }
  if (clash !== null) throw new Error('House answered a merged text holding a conflict it never closed');
  return read;
}

function sideOf(read: readonly Piece[], side: Side): string {
  return read.map((piece) => (typeof piece === 'string' ? piece : piece[side].join(''))).join('');
}

function written(read: readonly Piece[]): string {
  return read.map((piece) => (typeof piece === 'string' ? piece : whole(piece.current.join(''), piece.yours.join('')))).join('');
}

function topLines(document: Document): number {
  return lines(document.content.slice(0, document.listEnd)).length;
}

function below(read: readonly Piece[], current: number, yours: number): number | null {
  let [held, sent] = [0, 0];
  for (const [index, piece] of read.entries()) {
    if (held === current && sent === yours) return index;
    held += typeof piece === 'string' ? 1 : piece.current.length;
    sent += typeof piece === 'string' ? 1 : piece.yours.length;
  }
  return held === current && sent === yours ? read.length : null;
}

function valueOf(document: Document, name: string): unknown {
  return Object.hasOwn(document.fields, name) ? document.fields[name] : undefined;
}

function rangeOf(document: Document, name: string): Extent | undefined {
  return document.ranges[`/${escapePointer(name)}`];
}

function linesOf(document: Document, name: string): string {
  const range = rangeOf(document, name);
  return range === undefined ? '' : document.content.slice(range.start, range.end);
}

function frontmatterOf(content: string): string {
  return content.slice(0, content.length - bodyAfterFrontmatter(content).length);
}

function fieldsMerged(was: Document, now: Document, mine: Document, definition: Definition | undefined): Merged | null {
  const taken: string[] = [];
  const clashing: string[] = [];
  for (const name of new Set([was, now, mine].flatMap((document) => Object.keys(document.fields)))) {
    const [before, theirs, ours] = [valueOf(was, name), valueOf(now, name), valueOf(mine, name)];
    if (equalValue(before, ours) || equalValue(theirs, ours)) continue;
    (equalValue(before, theirs) ? taken : clashing).push(name);
  }
  const mineOver = (document: Document, names: readonly string[]) =>
    apply(document, names.map((name): Change => ({ kind: 'field', name, value: valueOf(mine, name), prior: valueOf(document, name) })), definition);
  const placed = mineOver(now, [...taken, ...clashing.filter((name) => valueOf(now, name) === undefined && rangeOf(mine, name) !== undefined)]);
  if (placed.outcome !== 'applied') return null;
  const { document } = placed;
  const spliced = [...taken.filter((name) => rangeOf(mine, name) !== undefined), ...clashing].flatMap((name) => {
    const range = rangeOf(document, name);
    if (range === undefined) return [];
    return [{ range, text: clashing.includes(name) ? whole(linesOf(now, name), linesOf(mine, name)) : ended(linesOf(mine, name)) }];
  });
  let text = document.content;
  for (const { range, text: into } of spliced.sort((left, right) => right.range.start - left.range.start)) {
    text = `${text.slice(0, range.start)}${into}${text.slice(range.end)}`;
  }
  const fenced = clashing.filter((name) => rangeOf(document, name) === undefined);
  if (fenced.length > 0) {
    const yours = mineOver(document, fenced);
    if (yours.outcome !== 'applied') return null;
    const held = frontmatterOf(text);
    text = `${whole(held, frontmatterOf(yours.document.content))}${text.slice(held.length)}`;
  }
  return { text, settled: clashing.length === 0 };
}

function roomTypes(schema: string | null): VerifiedModel | null {
  if (schema === null) return HOUSE_ROOM_TYPES;
  const verified = verifySchemaDocument(schema, HOUSE_ROOM_TYPES);
  return verified.verdict === 'accept' ? verified.model : null;
}

export function fieldMerged(file: string, schema: string | null, base: string, current: string, yours: string, answer: string): Merged {
  const kept = { text: answer, settled: false };
  const types = roomTypes(schema);
  if (types === null) return kept;
  const definitions = definitionAt(types, file, HOUSE_TYPED_PATHS);
  const read = (text: string): Document | null => {
    const parsed = parse(text, file, definitions);
    return parsed.ok ? parsed.document : null;
  };
  const top = (document: Document) => read(document.content.slice(0, document.listEnd));
  const clashes = pieces(answer);
  const [was, now, mine] = [base, current, yours].map(read);
  const [currentSide, yoursSide] = [sideOf(clashes, 'current'), sideOf(clashes, 'yours')].map(read);
  if (was === null || now === null || mine === null || currentSide === null || yoursSide === null || now.type !== was.type || mine.type !== was.type) return kept;
  const from = below(clashes, topLines(currentSide), topLines(yoursSide));
  const [wasTop, nowTop, mineTop] = [was, now, mine].map(top);
  if (from === null || wasTop === null || nowTop === null || mineTop === null) return kept;
  const fields = fieldsMerged(wasTop, nowTop, mineTop, definitions(now.type));
  if (fields === null) return kept;
  const rest = clashes.slice(from);
  return { text: `${fields.text}${written(rest)}`, settled: fields.settled && rest.every((piece) => typeof piece === 'string') };
}
