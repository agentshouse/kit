import { expect, it } from 'vitest';
import { changed } from '../src/translate.ts';
import { growth, GROWTH_BOUND } from './growth.ts';

const CAP = 1_000_000;
const FILE = 'notes/large.md';
const PATH = `/rooms/notes/${FILE}`;

function filled(bytes: number, piece: (index: number) => string): string[] {
  const pieces: string[] = [];
  let size = 0;
  for (let index = 0; size + piece(index).length <= bytes; index += 1) {
    pieces.push(piece(index));
    size += piece(index).length;
  }
  return pieces;
}

const SHAPES = {
  section: (bytes: number) => {
    const piece = (words: string) => (index: number) => `## Section ${index}\n\n${`${words} of one section. `.repeat(12)}\n\n`;
    return { before: filled(bytes, piece('Words')).join(''), after: filled(bytes, piece('Lines')).join('') };
  },
  field: (bytes: number) => {
    const piece = (value: string) => (index: number) => `f${index}: ${value.repeat(40)}${index}\n`;
    const fenced = (pieces: string[]) => `---\n${pieces.join('')}---\n`;
    return { before: fenced(filled(bytes - 8, piece('value-'))), after: fenced(filled(bytes - 8, piece('other-'))) };
  },
} as const;

it.each([
  ['section', 'replace_section'],
  ['field', 'set_field'],
] as const)('translates a document at the cap whose every %s changed in time that grows with its size', (shape, op) => {
  const translated = (bytes: number) => {
    const { before, after } = SHAPES[shape](bytes);
    return () => changed(PATH, FILE, 'base', before, after);
  };
  expect(growth(translated(CAP / 4), translated(CAP))).toBeLessThan(GROWTH_BOUND);
  const edits = translated(CAP)();
  expect(edits.length).toBeGreaterThan(1_000);
  expect(new Set(edits.map((edit) => edit.op))).toEqual(new Set([op]));
});
