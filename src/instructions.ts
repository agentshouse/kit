import type { Bridge } from './bridge.ts';
import { HOUSE_REF } from './git.ts';
import { readHowWeWork } from './skills.ts';

const SOURCE_LINE = "From House:";
const HOUSE_LINE = "Work with House through the `house` CLI: run `house --help`, and `house find_command` for House's guides and formats.";
const FILE_LINE = 'To give the User a file, upload it with `house upload` and link it; for an App, a Site or a website, follow `house find_command \'{"query":"app"}\'`. Never start a server.';
const READ_LINE = "Optional per-Room instructions: `/rooms/private/rooms/<handle>/AGENTS.md`.";
const COPIES_LINE = `House Local copies; before work run \`house fetch\` and rebase onto \`${HOUSE_REF}\`; after it commit, then \`house push\`:`;

export async function instructions(bridge: Bridge, base: string, copies: string[]): Promise<string> {
  const lines = [SOURCE_LINE, HOUSE_LINE, FILE_LINE, READ_LINE, ...(copies.length === 0 ? [] : [COPIES_LINE, ...copies])];
  return [lines.join('\n'), base, (await readHowWeWork(bridge)).replace(/\n$/, '')].filter((part) => part !== '').join('\n\n');
}
