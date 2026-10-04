import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
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

function update(hosted: Hosted, id: string, pin: { bootstrap: string; sha256: string }): void {
  hosted.socket.send({
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

it('reruns the verified bootstrap with --linux outside its own service and acknowledges the update', async () => {
  const hosted = await hostKit();
  const pin = await serve(hosted, 'printf "%s\\n" "$*" > "$HOUSE_KIT_HOME/bootstrap.ran"\n');

  update(hosted, 'update-1', pin);

  expect(await hosted.ack('update-1')).toEqual({});
  expect(await ran(hosted)).toBe('--linux\n');
  const launched = await readFile(join(hosted.home, 'systemd-run.log'), 'utf8');
  expect(launched).toMatch(
    /^--wait --collect --quiet --unit=house-kit-update-update-1 --setenv=HOME=\S+ \/bin\/sh -c bash "\$0" --linux; printf %s "\$\?" > "\$1"; systemctl start house-kit\.service \S+\/connect-linux\.sh \S+\/outcome\n$/,
  );
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
