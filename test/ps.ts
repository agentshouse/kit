import { readdirSync, readFileSync } from 'node:fs';

const [options, , format] = process.argv.slice(2);
const columns = (format ?? 'pid=,ppid=,command=').split(',').map((column) => column.replace('=', ''));
const listed: string[] = [];
for (const entry of readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  try {
    const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
    const [, parent, , session] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const words = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (options!.includes('E')) words.push(...readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').filter(Boolean));
    const values: Record<string, string> = { pid: entry.padStart(5), ppid: parent!.padStart(5), sess: session!, command: words.join(' ') };
    listed.push(columns.map((column) => values[column]).join(' '));
  } catch {}
}
process.stdout.write(`${listed.join('\n')}\n`);
