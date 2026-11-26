import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const watch = fs.watch;

fs.watch = ((path: fs.PathLike, options: fs.WatchOptions & { encoding?: 'utf8' }, listener: fs.WatchListener<string>) => {
  if (options?.recursive !== true) return watch(path, options, listener);
  const watcher = watch(path, { ...options, encoding: 'utf8' }, (event, name) => {
    if (!fs.existsSync(process.env.KIT_DEAF_WATCH!)) listener(event, name);
  });
  // Twenty milliseconds loses the watch as soon as the spec creates its signal.
  const losing = setInterval(() => {
    if (!fs.existsSync(process.env.KIT_LOST_WATCH!)) return;
    clearInterval(losing);
    fs.rmSync(process.env.KIT_LOST_WATCH!);
    watcher.emit('error', Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' }));
  }, 20);
  watcher.on('close', () => clearInterval(losing));
  return watcher;
}) as typeof fs.watch;
syncBuiltinESMExports();
