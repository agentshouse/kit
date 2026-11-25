import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const read = fs.readFileSync as (path: fs.PathOrFileDescriptor, ...rest: unknown[]) => unknown;

function state(pid: string): string {
  const stat = read(`/proc/${pid}/stat`, 'utf8') as string;
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!;
}

fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
  const answer = read(path, ...rest);
  const named = process.env.KIT_ENDING!;
  if (typeof path === 'string' && /^\/proc\/\d+\/stat$/.test(path) && fs.existsSync(named)) {
    const pid = (read(named, 'utf8') as string).trim();
    if (path === `/proc/${pid}/stat`) {
      fs.rmSync(named);
      process.kill(Number(pid), 'SIGKILL');
      // Five milliseconds sees the killed process turn into a zombie at once without spinning the Kit's thread.
      while (state(pid) !== 'Z') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  return answer;
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
