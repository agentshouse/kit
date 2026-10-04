import type { Bridge } from './bridge.ts';
import { HOW_WE_WORK } from './skills.ts';

const HOUSE_LINE = 'Work with House through the `house` CLI: run `house --help`.';
const FILE_LINE = 'To give the User a file or a page, upload it with `house upload_attachment` and link it; never start a server.';
const COPIES_LINE = 'House working copies; commit, then `house git push`:';
const UNREADABLE = /^(?:\S+: )?(?:path_not_found|room_not_found|operation_denied)\b/;
const FAILED = /^exit: [1-9]\d*$/;
const CUT = /^stderr: shell: output_cut (\d+) of \d+ bytes; continue with: (.+)$/;

function cutOf(lines: string[]): RegExpExecArray | null {
  const cut = CUT.exec(lines[0] ?? '');
  return cut !== null && Buffer.byteLength(lines.slice(1).join('\n')) === Number(cut[1]) ? cut : null;
}

async function howWeWork(bridge: Bridge): Promise<string> {
  let document = '';
  for (let command: string | undefined = `cat ${HOW_WE_WORK}`; command !== undefined; ) {
    const read = await bridge.tool('shell', { command });
    const text = read.content.map((content) => content.text).join('\n');
    const lines = text.split('\n');
    if (read.isError === true || (FAILED.test(lines[0] ?? '') && lines[1]?.startsWith('stderr: '))) {
      const refusal = read.isError === true ? text : lines.slice(1).join('\n').replace(/^stderr: /gm, '');
      if (UNREADABLE.test(refusal)) return '';
      throw new Error(refusal);
    }
    const cut = cutOf(lines);
    document += lines.slice(cut === null ? 0 : 1).join('\n');
    command = cut?.[2];
  }
  return document.replace(/\n$/, '');
}

export async function instructions(bridge: Bridge, base: string, copies: string[]): Promise<string> {
  const lines = [HOUSE_LINE, FILE_LINE, ...(copies.length === 0 ? [] : [COPIES_LINE, ...copies])];
  return [lines.join('\n'), base, await howWeWork(bridge)].filter((part) => part !== '').join('\n\n');
}
