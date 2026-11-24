import { stringify } from 'yaml';
import type { House } from './double.ts';
import type { ToolAnswer, ToolResult } from './environment.ts';

export type OwnSkills = Record<string, Readonly<Record<string, string>>>;

const CATALOGUE_PAGE = 4;
const CUT_CHARS = 1_000;

interface Cut {
  readonly field: string;
  readonly text: string;
}

function answered(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: stringify(value) }] };
}

function cutOf(field: string, shown: number, total: number): { cut?: { field: string; shown: number; total: number } } {
  return shown < total ? { cut: { field, shown, total } } : {};
}

function continued(cuts: readonly Cut[], value: number, from: number): { next_cursor?: string } {
  if (value >= cuts.length) return {};
  return from < cuts[value]!.text.length ? { next_cursor: `${value}@${from}` } : continued(cuts, value + 1, CUT_CHARS);
}

function ownAnswer(names: readonly string[], held: OwnSkills, cursor: string | undefined): ToolResult {
  const skills = names.filter((name) => name in held).map((name) => ({ name, files: held[name]! }));
  const cuts = skills.flatMap(({ files }) => Object.entries(files).flatMap(([field, text]) => (text.length > CUT_CHARS ? [{ field, text }] : [])));
  if (cursor === undefined) {
    const shown = skills.map(({ name, files }) => ({
      name,
      files: Object.fromEntries(Object.entries(files).flatMap(([field, text]) => Object.entries({ [field]: text.slice(0, CUT_CHARS), ...cutOf(field, CUT_CHARS, text.length) }))),
    }));
    return answered({ skills: shown, ...continued(cuts, 0, CUT_CHARS) });
  }
  const [value, from] = cursor.split('@').map(Number) as [number, number];
  const { field, text } = cuts[value]!;
  const through = Math.min(from + CUT_CHARS, text.length);
  return answered({ skills: [{ files: { [field]: text.slice(from, through), ...cutOf(field, through, text.length) } }], ...continued(cuts, value, through) });
}

export function catalogue(house: readonly string[], own: () => OwnSkills = () => ({})): ToolAnswer {
  return (args) => {
    const held = own();
    const names = args.names as string[] | undefined;
    const cursor = args.cursor as string | undefined;
    if (names !== undefined) return ownAnswer(names, held, cursor);
    const at = Number(cursor ?? 0);
    const listed = [...house.filter((name) => !(name in held)).map((name) => ({ name })), ...Object.keys(held).map((name) => ({ name, own: true }))];
    const rows = listed.sort((left, right) => (left.name < right.name ? -1 : 1));
    const next = at + CATALOGUE_PAGE < rows.length ? { next_cursor: String(at + CATALOGUE_PAGE) } : {};
    return answered({ catalogue: rows.slice(at, at + CATALOGUE_PAGE), ...next });
  };
}

export function serveCatalogue(house: House, names: readonly string[], own?: () => OwnSkills, path = '/'): void {
  const answer = catalogue(names, own);
  house.route('POST', path, async (request) => {
    const { id, params } = request.body as { id: string; params: { name: string; arguments: Record<string, unknown> } };
    return { body: { jsonrpc: '2.0', id, result: await answer(params.arguments, request) } };
  });
}
