import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { kitHome } from './home.ts';

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
  throw new Error(`the Kit service could not be started: ${cause}`);
}

function physical(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function systemdHome(environment: string): string | undefined {
  for (const [, quoted, bare] of environment.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const assignment = bare ?? quoted!.replace(/\\(.)/g, '$1');
    if (assignment.startsWith('HOUSE_KIT_HOME=')) return assignment.slice('HOUSE_KIT_HOME='.length);
  }
  return undefined;
}

function runsThisHome(served: string | undefined): boolean {
  return served !== undefined && physical(served) === physical(kitHome());
}

export function startService(): boolean {
  if (process.platform === 'darwin') {
    const service = `gui/${process.getuid!()}/house-kit`;
    const printed = manage('launchctl', ['print', service]);
    if (printed.status !== 0 || /^\tstate = running$/m.test(printed.stdout)) return false;
    if (!runsThisHome(/^\t+HOUSE_KIT_HOME => (.+)$/m.exec(printed.stdout)?.[1])) return false;
    start('launchctl', ['kickstart', service]);
    return true;
  }
  for (const scope of [['--user'], []]) {
    if (manage('systemctl', [...scope, 'is-enabled', '--quiet', UNIT]).status !== 0) continue;
    const environment = manage('systemctl', [...scope, 'show', '--property=Environment', '--value', UNIT]).stdout;
    if (!runsThisHome(systemdHome(environment))) continue;
    if (manage('systemctl', [...scope, 'is-active', '--quiet', UNIT]).status === 0) return false;
    start('systemctl', [...scope, 'start', UNIT]);
    return true;
  }
  return false;
}
