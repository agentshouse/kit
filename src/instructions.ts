import type { Bridge } from './bridge.ts';
import { readEnrolment } from './home.ts';

const HOUSE_LINE = 'Work with House through the `house` CLI: run `house --help`.';
const FILE_LINE = 'To give the User a file, upload it with `house upload_attachment` and link it in your answer.';
const COPIES_LINE = 'These House paths are Git working copies here; commit in one and run `house git push` to send the commit to House:';
const HOW_WE_WORK = '/private/library/how-we-work.md';
const UNREADABLE = /^(?:\S+: )?(?:path_not_found|room_not_found|operation_denied)\b/;
const CUT = /^stderr: shell: output_cut (\d+) of \d+ bytes; continue with: (.+)$/;

async function howWeWork(bridge: Bridge): Promise<string> {
  let document = '';
  for (let command: string | undefined = `cat ${HOW_WE_WORK}`; command !== undefined; ) {
    const read = await bridge.tool('shell', { command });
    const text = read.content.map((content) => content.text).join('\n');
    const lines = text.split('\n');
    let at = lines[5]?.startsWith('authority: ') ? 6 : 5;
    if (read.isError === true || lines[2] !== 'exit: 0') {
      const refusal = read.isError === true ? text : lines.slice(at).join('\n').replace(/^stderr: /gm, '');
      if (UNREADABLE.test(refusal)) return '';
      throw new Error(refusal);
    }
    const cut = lines[3] === 'truncation: egress' ? CUT.exec(lines[at++] ?? '') : null;
    const shown = Buffer.from(`${lines.slice(at).join('\n')}\n`);
    document += (cut === null ? shown : shown.subarray(0, Number(cut[1]))).toString();
    command = cut?.[2];
  }
  return document.replace(/\n$/, '');
}

export async function instructions(bridge: Bridge, base: string, copies: string[]): Promise<string> {
  const app = new URL('/app/new.git', (await readEnrolment())!.house).href;
  const appLine = `To show the User a page, upload it or push it to an App instead of starting a server; \`git clone ${app}\` starts a new App.`;
  const lines = [HOUSE_LINE, FILE_LINE, appLine, ...(copies.length === 0 ? [] : [COPIES_LINE, ...copies])];
  return [lines.join('\n'), base, await howWeWork(bridge)].filter((part) => part !== '').join('\n\n');
}
