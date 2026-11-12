import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { oneFolder } from './home.ts';

const SERVICE = 'house-kit';
const UNIT = `${SERVICE}.service`;
// launchctl, loginctl and systemctl answer at once, so ten seconds only bounds a stuck service manager.
const MANAGER_MS = 10_000;
// A Kit that failed restarts after five seconds, back soon without spinning on a failure that repeats; a Kit that ended itself stays stopped.
const RESTART_SECONDS = 5;

export function userUnit(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', UNIT);
}

export function launchAgent(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE}.plist`);
}

export function launcher(): string {
  return join(oneFolder(), 'bin', 'kit');
}

export function systemd(): boolean {
  return existsSync('/run/systemd/system');
}

function userBus(): NodeJS.ProcessEnv {
  if (process.env.XDG_RUNTIME_DIR) return process.env;
  return { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}` };
}

export function manage(command: string, args: string[]) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: MANAGER_MS, env: command === 'systemctl' ? userBus() : process.env });
}

export function required(command: string, args: string[], failed: string): void {
  const ran = manage(command, args);
  if (ran.status === 0) return;
  const cause = ran.error?.message ?? (ran.stderr.trim() || `${command} exited with ${ran.status ?? 'a signal'}`);
  throw new Error(`${failed}: ${cause}`);
}

function unitWord(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function xmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function unitText(): string {
  return `[Unit]
Description=Kit

[Service]
ExecStart=${unitWord(launcher())} resident
Restart=on-failure
RestartSec=${RESTART_SECONDS}
Delegate=yes
OOMPolicy=continue

[Install]
WantedBy=default.target
`;
}

function plistText(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${SERVICE}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xmlText(launcher())}</string>
\t\t<string>resident</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlText(join(oneFolder(), 'kit.log'))}</string>
</dict>
</plist>
`;
}

async function define(path: string, text: string): Promise<boolean> {
  if ((await readFile(path, 'utf8').catch(() => null)) === text) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.new`, text);
  await rename(`${path}.new`, path);
  return true;
}

export function defineSupervisor(): Promise<boolean> {
  return process.platform === 'darwin' ? define(launchAgent(), plistText()) : define(userUnit(), unitText());
}

export function linger(): void {
  required('loginctl', ['enable-linger', String(process.getuid!())], 'lingering could not be turned on for this account');
  if (process.getuid!() === 0) required('systemctl', ['start', 'user@0.service'], "root's service manager could not be started");
}

function macos(): { target: string; service: string } {
  const target = `gui/${process.getuid!()}`;
  return { target, service: `${target}/${SERVICE}` };
}

export function supervise(changed: boolean, restart: boolean): void {
  if (process.platform === 'darwin') {
    const { target, service } = macos();
    const printed = manage('launchctl', ['print', service]);
    const loaded = printed.status === 0;
    if (loaded && changed) required('launchctl', ['bootout', service], 'the Kit service could not be stopped');
    if (!loaded || changed) {
      manage('launchctl', ['enable', service]);
      required('launchctl', ['bootstrap', target, launchAgent()], 'the Kit service could not be started');
    } else if (restart) {
      required('launchctl', ['kickstart', '-k', service], 'the Kit service could not be restarted');
    } else if (!/^\tstate = running$/m.test(printed.stdout)) {
      required('launchctl', ['kickstart', service], 'the Kit service could not be started');
    }
    return;
  }
  linger();
  if (changed) required('systemctl', ['--user', 'daemon-reload'], 'systemd could not read the Kit service');
  required('systemctl', ['--user', '--quiet', 'enable', UNIT], 'the Kit service could not be enabled');
  if (manage('systemctl', ['--user', '--quiet', 'is-active', UNIT]).status !== 0) {
    required('systemctl', ['--user', 'start', UNIT], 'the Kit service could not be started');
  } else if (changed || restart) {
    required('systemctl', ['--user', 'restart', UNIT], 'the Kit service could not be restarted');
  }
}

export function startService(): boolean {
  if (process.platform === 'darwin') {
    const { service } = macos();
    const printed = manage('launchctl', ['print', service]);
    if (printed.status !== 0 || /^\tstate = running$/m.test(printed.stdout)) return false;
    required('launchctl', ['kickstart', service], 'the Kit service could not be started');
    return true;
  }
  if (manage('systemctl', ['--user', '--quiet', 'is-enabled', UNIT]).status !== 0) return false;
  if (manage('systemctl', ['--user', '--quiet', 'is-active', UNIT]).status === 0) return false;
  required('systemctl', ['--user', 'start', UNIT], 'the Kit service could not be started');
  return true;
}
