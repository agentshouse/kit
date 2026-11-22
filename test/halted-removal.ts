import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';

const rm = fs.promises.rm;
fs.promises.rm = (async (path: fs.PathLike, options?: fs.RmOptions) => {
  const halted = process.env.KIT_HALTED_REMOVAL!;
  if (options?.recursive === true && fs.existsSync(halted)) {
    const first = fs.readFileSync(halted, 'utf8');
    if (String(path) === dirname(first)) {
      fs.rmSync(halted);
      await rm(first);
      process.kill(process.pid, 'SIGKILL');
    }
  }
  await rm(path, options);
}) as typeof fs.promises.rm;
syncBuiltinESMExports();
