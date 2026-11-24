import { stringify } from 'yaml';
import type { House } from './double.ts';
import type { ToolAnswer, ToolResult } from './environment.ts';

export type OwnSkills = Record<string, Readonly<Record<string, string>>>;

const CATALOGUE_PAGE = 4;

function paged(field: string, rows: readonly unknown[], at: number, size: number): ToolResult {
  const next = at + size < rows.length ? { next_cursor: String(at + size) } : {};
  return { content: [{ type: 'text', text: stringify({ [field]: rows.slice(at, at + size), ...next }) }] };
}

export function catalogue(house: readonly string[], own: () => OwnSkills = () => ({})): ToolAnswer {
  return (args) => {
    const held = own();
    const names = args.names as string[] | undefined;
    const at = Number(args.cursor ?? 0);
    if (names === undefined) {
      const listed = [...house.filter((name) => !(name in held)).map((name) => ({ name })), ...Object.keys(held).map((name) => ({ name, own: true }))];
      return paged('catalogue', listed.sort((left, right) => (left.name < right.name ? -1 : 1)), at, CATALOGUE_PAGE);
    }
    return paged(
      'skills',
      names.filter((name) => name in held).map((name) => ({ name, files: held[name] })),
      at,
      1,
    );
  };
}

export function serveCatalogue(house: House, names: readonly string[], own?: () => OwnSkills, path = '/'): void {
  const answer = catalogue(names, own);
  house.route('POST', path, async (request) => {
    const { id, params } = request.body as { id: string; params: { name: string; arguments: Record<string, unknown> } };
    return { body: { jsonrpc: '2.0', id, result: await answer(params.arguments, request) } };
  });
}
