import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startProxy, until, type Proxy } from './double.ts';
import { appRemote, attachmentDouble, directed, hostKit, opened, runs } from './environment.ts';

const PROXY = /^https?_proxy$/i;

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

it("starts a Conversation process without the proxy variables the resident's environment carries", async () => {
  const proxy = await startProxy();
  const hosted = await hostKit([{}], { tls: true, environment: variables(proxy) });

  await opened(hosted);

  const started = (await hosted.adapterLog()).find(
    (entry) => entry.method === 'initialize' && (entry.env as Record<string, string>).HOUSE_BRIDGE !== undefined,
  )!;
  expect(Object.keys(started.env as Record<string, string>).filter((name) => PROXY.test(name))).toEqual([]);
  expect(proxy.tunnels).not.toEqual([]);
});
