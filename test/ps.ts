import { readdirSync, readFileSync } from 'node:fs';

const [options] = process.argv.slice(2);
const listed: string[] = [];
for (const entry of readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  try {
    const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
    const parent = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]!;
    const words = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (options!.includes('E')) words.push(...readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').filter(Boolean));
    listed.push(`${entry.padStart(5)} ${parent.padStart(5)} ${words.join(' ')}`);
  } catch {}
}
process.stdout.write(`${listed.join('\n')}\n`);
