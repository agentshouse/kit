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
import { holdsMarker } from './manifest.ts';

const OPENING = '<<<<<<< current';
const BETWEEN = '=======';
const CLOSING = '>>>>>>> yours';

type Side = 'current' | 'yours';

interface Clash {
  current: string[];
  yours: string[];
  text: string;
}

type Piece = string | Clash;

export interface Merged {
  text: string;
  settled: boolean;
}

export function whole(theirs: string, mine: string): string {
  return `${OPENING}\n${ended(theirs)}${BETWEEN}\n${ended(mine)}${CLOSING}\n`;
}

function ended(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

function lines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/u);
}

function pieces(merged: string): Piece[] | null {
  const read: Piece[] = [];
  let clash: Clash | null = null;
  let side: Side = 'current';
  for (const line of lines(merged)) {
    const bare = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (clash === null) {
      if (bare !== OPENING) read.push(line);
      else [clash, side] = [{ current: [], yours: [], text: line }, 'current'];
      continue;
    }
    clash.text += line;
    if (side === 'current' && bare === BETWEEN) side = 'yours';
    else if (side === 'yours' && bare === CLOSING) {
      read.push(clash);
      clash = null;
    } else clash[side].push(line);
  }
  return clash === null ? read : null;
}

function sideOf(read: readonly Piece[], side: Side): string {
  return read.map((piece) => (typeof piece === 'string' ? piece : piece[side].join(''))).join('');
}

function written(read: readonly Piece[]): string {
  return read.map((piece) => (typeof piece === 'string' ? piece : piece.text)).join('');
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

function shape(document: Document): string {
  const cuts = Object.keys(document.fields)
    .flatMap((name) => {
      const range = rangeOf(document, name);
      return range === undefined ? [] : [{ name, range }];
    })
    .sort((left, right) => left.range.start - right.range.start);
  const parts: string[] = [];
  let at = 0;
  for (const { name, range } of cuts) {
    parts.push(document.content.slice(at, range.start), name);
    at = range.end;
  }
  parts.push(document.content.slice(at));
  return JSON.stringify(parts);
}

function fieldsMerged(was: Document, now: Document, mine: Document, definition: Definition | undefined): Merged | null {
  const names = [...new Set([was, now, mine].flatMap((document) => Object.keys(document.fields)))];
  const changedIn = (side: Document) => names.filter((name) => !equalValue(valueOf(was, name), valueOf(side, name)));
  const over = (document: Document, from: Document, changed: readonly string[]) =>
    apply(document, changed.map((name): Change => ({ kind: 'field', name, value: valueOf(from, name), prior: valueOf(document, name) })), definition);
  const own = (side: Document, changed: readonly string[]) => {
    const redone = over(was, side, changed);
    return redone.outcome !== 'applied' || shape(redone.document) !== shape(side);
  };
  const [byNow, byMine] = [changedIn(now), changedIn(mine)];
  const [nowOwn, mineOwn] = [own(now, byNow), own(mine, byMine)];
  if (nowOwn && mineOwn) return null;
  const [onto, other] = mineOwn ? [mine, now] : [now, mine];
  const [byOnto, byOther] = mineOwn ? [byMine, byNow] : [byNow, byMine];
  const clashing = byNow.filter((name) => byMine.includes(name) && !equalValue(valueOf(now, name), valueOf(mine, name)));
  const taken = byOther.filter((name) => !byOnto.includes(name));
  const placed = over(onto, other, [...taken, ...clashing.filter((name) => valueOf(onto, name) === undefined && rangeOf(other, name) !== undefined)]);
  if (placed.outcome !== 'applied') return null;
  const { document } = placed;
  const spliced = [...taken.filter((name) => rangeOf(other, name) !== undefined), ...clashing].flatMap((name) => {
    const range = rangeOf(document, name);
    if (range === undefined) return [];
    return [{ range, text: clashing.includes(name) ? whole(linesOf(now, name), linesOf(mine, name)) : ended(linesOf(other, name)) }];
  });
  let text = document.content;
  for (const { range, text: into } of spliced.sort((left, right) => right.range.start - left.range.start)) {
    text = `${text.slice(0, range.start)}${into}${text.slice(range.end)}`;
  }
  const fenced = clashing.filter((name) => rangeOf(document, name) === undefined);
  if (fenced.length > 0) {
    const swapped = over(document, other, fenced);
    if (swapped.outcome !== 'applied') return null;
    const [held, others] = [frontmatterOf(text), frontmatterOf(swapped.document.content)];
    text = `${onto === now ? whole(held, others) : whole(others, held)}${text.slice(held.length)}`;
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
  const clashes = pieces(answer);
  if (types === null || clashes === null) return kept;
  const definitions = definitionAt(types, file, HOUSE_TYPED_PATHS);
  const read = (text: string): Document | null => {
    const parsed = parse(text, file, definitions);
    return parsed.ok ? parsed.document : null;
  };
  const top = (document: Document) => read(document.content.slice(0, document.listEnd));
  const [was, now, mine] = [base, current, yours].map(read);
  const [currentSide, yoursSide] = [sideOf(clashes, 'current'), sideOf(clashes, 'yours')].map(read);
  if (was === null || now === null || mine === null || currentSide === null || yoursSide === null || now.type !== was.type || mine.type !== was.type) return kept;
  const from = below(clashes, topLines(currentSide), topLines(yoursSide));
  const [wasTop, nowTop, mineTop] = [was, now, mine].map(top);
  if (from === null || wasTop === null || nowTop === null || mineTop === null) return kept;
  const fields = fieldsMerged(wasTop, nowTop, mineTop, definitions(now.type));
  if (fields === null) return kept;
  const rest = clashes.slice(from);
  const text = `${fields.text}${written(rest)}`;
  return { text, settled: fields.settled && rest.every((piece) => typeof piece === 'string') && !holdsMarker(text) };
}
