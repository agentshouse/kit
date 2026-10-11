import { spawnSync } from 'node:child_process';

const UNIT = 'house-kit.service';
// launchctl and systemctl answer at once, so ten seconds only bounds a stuck service manager.
const MANAGER_MS = 10_000;

function manage(command: string, args: string[]) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: MANAGER_MS });
}

function start(command: string, args: string[]): void {
  const started = manage(command, args);
  if (started.status === 0) return;
  const cause = started.error?.message ?? (started.stderr.trim() || `${command} exited with ${started.status ?? 'a signal'}`);
  throw new Error(`the House Kit service could not be started: ${cause}`);
}

export function startService(): boolean {
  if (process.platform === 'darwin') {
    const service = `gui/${process.getuid!()}/house-kit`;
    const printed = manage('launchctl', ['print', service]);
    if (printed.status !== 0 || /^\tstate = running$/m.test(printed.stdout)) return false;
    start('launchctl', ['kickstart', service]);
    return true;
  }
  for (const scope of [['--user'], []]) {
    if (manage('systemctl', [...scope, 'is-enabled', '--quiet', UNIT]).status !== 0) continue;
    if (manage('systemctl', [...scope, 'is-active', '--quiet', UNIT]).status === 0) return false;
    start('systemctl', [...scope, 'start', UNIT]);
    return true;
  }
  return false;
}
