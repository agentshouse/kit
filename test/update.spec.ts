import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { settle, until } from './double.ts';
import { hostKit, type Hosted } from './environment.ts';
import { fakeBin, runKit } from './kit.ts';

const SYSTEMD_RUN = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOUSE_KIT_HOME/systemd-run.log"
printf '%s' "$PPID" > "$HOUSE_KIT_HOME/resident.pid"
while [ "\${1#--}" != "$1" ]; do shift; done
exec "$@"
`;

const KILL_RESIDENT = 'kill -9 "$(cat "$HOUSE_KIT_HOME/resident.pid")"\n';

async function serve(hosted: Hosted, script: string): Promise<{ bootstrap: string; sha256: string }> {
  await writeFile(join(hosted.home, 'bin', 'systemd-run'), SYSTEMD_RUN);
  await chmod(join(hosted.home, 'bin', 'systemd-run'), 0o755);
  hosted.house.route('GET', '/releases/connect-linux.sh', () => ({
    bytes: { type: 'text/x-shellscript', content: script },
  }));
  return {
    bootstrap: `${hosted.house.origin}/releases/connect-linux.sh`,
    sha256: createHash('sha256').update(script).digest('hex'),
  };
}

function update(hosted: Hosted, id: string, pin: { bootstrap: string; sha256: string; update_clis?: boolean }): void {
  hosted.house.sockets.at(-1)!.send({
    type: 'input',
    input_id: id,
    kind: 'update',
    conversation_id: null,
    agent_id: null,
    provider_session_id: null,
    ...pin,
  });
}

const ran = (hosted: Hosted) => readFile(join(hosted.home, 'bootstrap.ran'), 'utf8').catch(() => undefined);

// The bootstrap looks for the spec's go file every tenth of a second, so it runs until the spec lets it end.
const HELD = 'until [ -e "$HOUSE_KIT_HOME/go" ]; do sleep 0.1; done\nprintf "%s\\n" "$*" >> "$HOUSE_KIT_HOME/bootstrap.ran"\n';

const FAST_INTERVALS = fileURLToPath(new URL('./fast-intervals.ts', import.meta.url));

const downloaded = (hosted: Hosted) => hosted.house.requests.find((request) => request.path === '/releases/connect-linux.sh');

const checkpoint = (hosted: Hosted) => readFile(join(hosted.home, 'update', 'pending.json'), 'utf8').catch(() => undefined);

it('reruns the verified bootstrap with --linux outside its own service and acknowledges the update', async () => {
  const hosted = await hostKit();
  const pin = await serve(hosted, 'printf "%s\\n" "$*" > "$HOUSE_KIT_HOME/bootstrap.ran"\n');

  update(hosted, 'update-1', pin);

  expect(await hosted.ack('update-1')).toEqual({});
  expect(await ran(hosted)).toBe('--linux\n');
  const launched = await readFile(join(hosted.home, 'systemd-run.log'), 'utf8');
  expect(launched).toMatch(
    /^--wait --collect --quiet --unit=house-kit-update-update-1 --setenv=HOME=\S+ --setenv=HOUSE_KIT_HOME=\S+ \/bin\/sh -c outcome=\$1; shift; bash "\$0" "\$@"; printf %s "\$\?" > "\$outcome"; systemctl start house-kit\.service \S+\/connect-linux\.sh \S+\/outcome --linux\n$/,
  );
});

it('reruns the bootstrap of its desktop placement in its workspace through the user service manager when it runs as a user service', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'kit-workspace-'));
  onTestFinished(() => rm(workspace, { recursive: true, force: true }));
  const hosted = await hostKit([{}], {
    environment: { INVOCATION_ID: 'invocation', MANAGERPID: '1', HOUSE_KIT_WORKSPACE: workspace },
  });
  await writeFile(join(hosted.home, 'bin', 'systemctl'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$HOUSE_KIT_HOME/systemctl.log"\n');
  await chmod(join(hosted.home, 'bin', 'systemctl'), 0o755);
  const pin = await serve(hosted, 'printf "%s\\n" "$*" > "$HOUSE_KIT_HOME/bootstrap.ran"\n');

  update(hosted, 'update-user', { ...pin, update_clis: true });

  expect(await hosted.ack('update-user')).toEqual({});
  expect(await ran(hosted)).toBe(`--workspace ${workspace} --update-clis\n`);
  expect(await readFile(join(hosted.home, 'systemd-run.log'), 'utf8')).toMatch(
    /^--user --wait --collect --quiet --unit=house-kit-update-update-user --setenv=HOME=\S+ --setenv=HOUSE_KIT_HOME=\S+ \/bin\/sh -c outcome=\$1; shift; bash "\$0" "\$@"; printf %s "\$\?" > "\$outcome"; systemctl --user start house-kit\.service \S+\/connect-linux\.sh \S+\/outcome --workspace \S+ --update-clis\n$/,
  );
  expect(await readFile(join(hosted.home, 'systemctl.log'), 'utf8')).toBe('--user start house-kit.service\n');
});

it('reruns the bootstrap with --linux as its own account through sudo when it runs as the system service of an account that is not root', async () => {
  const hosted = await hostKit([{}], { environment: { INVOCATION_ID: 'invocation' } });
  await writeFile(join(hosted.home, 'bin', 'sudo'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$HOUSE_KIT_HOME/sudo.log"\nshift\nexec "$@"\n', { mode: 0o755 });
  await writeFile(join(hosted.home, 'bin', 'systemctl'), '#!/bin/sh\n', { mode: 0o755 });
  const pin = await serve(hosted, 'printf "%s\\n" "$*" > "$HOUSE_KIT_HOME/bootstrap.ran"\n');

  update(hosted, 'update-sudo', pin);

  expect(await hosted.ack('update-sudo')).toEqual({});
  expect(await ran(hosted)).toBe('--linux\n');
  const elevated = (await readFile(join(hosted.home, 'sudo.log'), 'utf8')).split('\n');
  expect(elevated).toContainEqual(expect.stringMatching(new RegExp(`^-n systemd-run --uid=${process.getuid!()} --gid=${process.getgid!()} --wait `)));
  expect(elevated).toContain('-n systemctl start house-kit.service');
});

it.each([
  [true, '--linux --update-clis\n'],
  [false, '--linux\n'],
])('reruns the bootstrap with --update-clis only when the update input carries the flag (%s)', async (flag, argv) => {
  const hosted = await hostKit();
  const pin = await serve(hosted, 'printf "%s\\n" "$*" > "$HOUSE_KIT_HOME/bootstrap.ran"\n');

  update(hosted, `update-flag-${flag}`, { ...pin, update_clis: flag });

  expect(await hosted.ack(`update-flag-${flag}`)).toEqual({});
  expect(await ran(hosted)).toBe(argv);
});

it('refuses a bootstrap that does not match its sha256 and runs nothing', async () => {
  const hosted = await hostKit();
  const pin = await serve(hosted, 'touch "$HOUSE_KIT_HOME/bootstrap.ran"\n');

  update(hosted, 'update-2', { ...pin, sha256: '0'.repeat(64) });

  expect(await hosted.ack('update-2')).toEqual({ refused: 'the Kit bootstrap does not match its sha256' });
  expect(await ran(hosted)).toBeUndefined();
});

it('carries two updates one after the other, each with its own bootstrap and status', async () => {
  const hosted = await hostKit();
  // The failing bootstrap runs half a second, so the second update arrives while it runs.
  const failing = await serve(hosted, 'sleep 0.5\nexit 3\n');
  const passing = {
    bootstrap: `${hosted.house.origin}/releases/next/connect-linux.sh`,
    sha256: createHash('sha256').update('printf "%s\\n" "$*" > "$HOUSE_KIT_HOME/bootstrap.ran"\n').digest('hex'),
  };
  hosted.house.route('GET', '/releases/next/connect-linux.sh', () => ({
    bytes: { type: 'text/x-shellscript', content: 'printf "%s\\n" "$*" > "$HOUSE_KIT_HOME/bootstrap.ran"\n' },
  }));

  update(hosted, 'update-6', failing);
  update(hosted, 'update-7', passing);

  expect(await hosted.ack('update-6')).toEqual({ refused: 'the Kit bootstrap exited with 3' });
  expect(await hosted.ack('update-7')).toEqual({});
  expect(await ran(hosted)).toBe('--linux\n');
  expect(hosted.acks.map((ack) => ack.params.input)).toEqual(['update-6', 'update-7']);
});

it('refuses the update with the exit status of a bootstrap that fails', async () => {
  const hosted = await hostKit();
  const pin = await serve(hosted, 'exit 3\n');

  update(hosted, 'update-3', pin);

  expect(await hosted.ack('update-3')).toEqual({ refused: 'the Kit bootstrap exited with 3' });
});

it('reruns no bootstrap for an update its reopened socket sends after the update ended, and acknowledges it again', async () => {
  const hosted = await hostKit();
  const pin = await serve(hosted, HELD);
  update(hosted, 'update-8', pin);
  await until(() => downloaded(hosted));
  hosted.socket.close(1001, 'shutting_down');
  await until(() => hosted.house.sockets[1]);
  await writeFile(join(hosted.home, 'go'), '');
  await hosted.ack('update-8');
  await until(async () => (await checkpoint(hosted)) === undefined);

  update(hosted, 'update-8', pin);

  await until(() => hosted.acks[1]);
  await settle();
  expect(await ran(hosted)).toBe('--linux\n');
  expect(hosted.acks.map((ack) => [ack.params.input, ack.body])).toEqual([
    ['update-8', {}],
    ['update-8', {}],
  ]);
});

it('reports no idle while an update runs and reports idle once it acknowledged the update', async () => {
  const hosted = await hostKit([{}], { environment: { NODE_OPTIONS: `--import=${FAST_INTERVALS}` } });
  const pin = await serve(hosted, HELD);
  update(hosted, 'update-9', pin);
  await until(() => downloaded(hosted));
  await settle();
  expect(hosted.idles).toHaveLength(1);

  await writeFile(join(hosted.home, 'go'), '');

  await hosted.ack('update-9');
  await until(() => hosted.idles[1]);
  const paths = hosted.house.requests.map((request) => request.path);
  expect(paths.lastIndexOf('/kit/idle')).toBeGreaterThan(paths.indexOf('/kit/inputs/update-9/ack'));
});

it('reports no idle while an update waits behind another and reports idle once it acknowledged both', async () => {
  const hosted = await hostKit([{}], { environment: { NODE_OPTIONS: `--import=${FAST_INTERVALS}` } });
  const first = await serve(hosted, HELD);
  const next = 'printf "%s\\n" "$*" >> "$HOUSE_KIT_HOME/bootstrap.ran"\n';
  hosted.house.route('GET', '/releases/next/connect-linux.sh', () => ({
    bytes: { type: 'text/x-shellscript', content: next },
  }));
  update(hosted, 'update-10', first);
  await until(() => downloaded(hosted));
  update(hosted, 'update-11', {
    bootstrap: `${hosted.house.origin}/releases/next/connect-linux.sh`,
    sha256: createHash('sha256').update(next).digest('hex'),
  });
  await settle();

  await writeFile(join(hosted.home, 'go'), '');

  await hosted.ack('update-11');
  await until(() => hosted.idles[1]);
  await settle();
  const reported = hosted.house.requests
    .map((request) => request.path)
    .filter((path) => path === '/kit/idle' || path.endsWith('/ack'));
  expect(reported).toEqual(['/kit/idle', '/kit/inputs/update-10/ack', '/kit/inputs/update-11/ack', '/kit/idle']);
});

async function restartAfter(hosted: Hosted, id: string, script: string): Promise<unknown> {
  const pin = await serve(hosted, script);
  update(hosted, id, pin);
  await hosted.kit.exited;
  await until(() => readFile(join(hosted.home, 'update', 'outcome'), 'utf8').catch(() => undefined));
  expect(hosted.acks).toHaveLength(0);
  const restarted = runKit(['resident'], { HOUSE_KIT_HOME: hosted.home, PATH: await fakeBin(hosted.home) });
  const ack = await hosted.ack(id);
  await until(() => hosted.house.sockets[1]);
  process.kill(restarted.pid, 'SIGKILL');
  await restarted.exited;
  return ack;
}

it('acknowledges the update once the Kit it restarted runs again', async () => {
  const hosted = await hostKit();

  expect(await restartAfter(hosted, 'update-4', KILL_RESIDENT)).toEqual({});
});

it('refuses an update whose bootstrap failed after it stopped the Kit', async () => {
  const hosted = await hostKit();

  expect(await restartAfter(hosted, 'update-5', `${KILL_RESIDENT}exit 3\n`)).toEqual({
    refused: 'the Kit bootstrap exited with 3',
  });
});
