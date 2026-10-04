import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startProxy, until, type Proxy } from './double.ts';
import { appRemote, attachmentDouble, directed, hostKit, installHeld, opened, runs } from './environment.ts';
import type { Started } from './started.ts';

function variables(proxy: Proxy): Record<string, string> {
  return { HTTPS_PROXY: proxy.origin, HTTP_PROXY: proxy.origin, https_proxy: proxy.origin, http_proxy: proxy.origin };
}

it.each([
  { route: 'through the proxy the standard variables name', proxied: true },
  { route: 'directly when no proxy variable is set', proxied: false },
])('reaches House $route with the stream, an HTTPS call and a Git call', async ({ proxied }) => {
  const proxy = await startProxy();
  const hosted = await hostKit([{}], { tls: true, environment: proxied ? variables(proxy) : {} });
  const commit = 'a'.repeat(40);
  const credentials = appRemote(hosted, commit);
  const transfers = await attachmentDouble(hosted);
  await writeFile(join(hosted.workingDirectory, 'report.txt'), 'quarterly numbers\n');
  await opened(hosted);

  directed(
    hosted,
    `@git ls-remote ${hosted.house.origin}/app/a_app.git\n@house upload_attachment {"path":"report.txt","room_ref":"r_room"}`,
  );
  const [git, upload] = await runs(hosted, 2);
  hosted.socket.close(1012, 'restart');
  await until(() => hosted.house.sockets[1]);

  expect(git).toMatchObject({ status: 0, stdout: `${commit}\tHEAD\n${commit}\trefs/heads/main\n` });
  expect(credentials).toHaveLength(1);
  expect(upload).toMatchObject({ status: 0 });
  expect(transfers).toHaveLength(1);
  const reached = (path: string) =>
    hosted.house.requests.filter((received) => received.path === path).map((received) => proxy.carried(received));
  expect({
    stream: reached('/kit/stream'),
    credential: reached('/kit/conversations/conversation-1/credential'),
    transfer: reached('/bytes/upload-1'),
    git: reached('/app/a_app.git/info/refs'),
  }).toEqual({ stream: [proxied, proxied], credential: [proxied], transfer: [proxied], git: [proxied] });
  expect(hosted.house.requests.filter((received) => proxy.carried(received) !== proxied)).toEqual([]);
  expect(new Set(proxy.tunnels)).toEqual(new Set(proxied ? [new URL(hosted.house.origin).host] : []));
});

it('starts every process, a CLI install, a sign-in and a Conversation process, without the proxy variables', async () => {
  const proxy = await startProxy();
  const hosted = await hostKit([{}], { tls: true, environment: variables(proxy) });
  await rm(await installHeld(hosted));
  hosted.input({ kind: 'sign_in', conversation_id: null, cli: 'codex-acp' });

  await opened(hosted, 'conversation-1', 'agent-2');

  const started = await until(async () => {
    const entries = (await readFile(join(hosted.home, 'started.log'), 'utf8').catch(() => ''))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Started);
    const names = new Set(entries.map((entry) => entry.name));
    return ['npm', 'device-login', 'adapter'].every((name) => names.has(name)) ? entries : undefined;
  });
  expect(started.filter((entry) => entry.proxy.length > 0)).toEqual([]);
  expect(proxy.tunnels).not.toEqual([]);
});
