import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { startHouse, type House } from './double.ts';
import { helpLine, LISTING, shelled, type McpCall } from './environment.ts';
import { runKit, temporaryHome } from './kit.ts';

const HOUSE = fileURLToPath(new URL('../src/house-main.ts', import.meta.url));

function runHouse(
  home: string,
  argv: string[],
  bridge?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, HOUSE_KIT_HOME: home };
    delete environment.HOUSE_BRIDGE;
    if (bridge !== undefined) environment.HOUSE_BRIDGE = bridge;
    const child = spawn(process.execPath, [HOUSE, ...argv], { env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function connected(house: House, own: boolean): Promise<string> {
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_kit' }));
  if (own) await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: house.origin, user: 'user-one', credential: 'ahp_own' }));
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    const result = message.method === 'tools/list' ? { tools: LISTING } : shelled(`found for ${String(message.params.arguments?.query)}`);
    return { body: { jsonrpc: '2.0', id: message.id, result } };
  });
  return home;
}

it("sends a Tool call outside a conversation to House's root under the User's own agent's connection and prints House's answer", async () => {
  const house = await startHouse();
  const home = await connected(house, true);

  const ran = await runHouse(home, ['search', '{"query":"invoice"}']);

  expect(ran).toEqual({ status: 0, stdout: 'found for invoice\n', stderr: '' });
  const [call] = house.requests;
  expect(call).toMatchObject({ path: '/', headers: { authorization: 'Bearer ahp_own' } });
  expect((call!.body as McpCall).params).toMatchObject({ name: 'search', arguments: { query: 'invoice' } });
});

it("uploads a local file outside a conversation through the upload Tool and posts its bytes to the answered grant", async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  const content = Buffer.from([0, 1, 2, 255]);
  const path = join(home, 'cover.bin');
  await writeFile(path, content);
  const posted: { operation: unknown; authorization: unknown; bytes: Buffer }[] = [];
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    const text = JSON.stringify({
      attachment: 'at_1.a',
      upload: { method: 'POST', operation: 'operation-1', url: `${house.origin}/bytes/grant-1`, expires_at: '2026-10-10T12:00:00Z' },
    });
    return { body: { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } } };
  });
  house.route('POST', '/bytes/:grant', (received) => {
    posted.push({
      operation: received.headers['x-house-byte-operation'],
      authorization: received.headers.authorization,
      bytes: received.body as Buffer,
    });
    return { body: { attachment: 'at_1.a' } };
  });

  const ran = await runHouse(home, ['upload', JSON.stringify({ path, room_ref: 'r_room' })]);

  expect(ran).toEqual({ status: 0, stdout: '{"attachment":"at_1.a"}\n', stderr: '' });
  const [call] = house.requests;
  expect(call).toMatchObject({ path: '/', headers: { authorization: 'Bearer ahp_own' } });
  expect((call!.body as McpCall).params).toMatchObject({
    name: 'upload',
    arguments: { room_ref: 'r_room', name: 'cover.bin', bytes: 4, sha256: createHash('sha256').update(content).digest('hex') },
  });
  expect(posted).toEqual([{ operation: 'operation-1', authorization: undefined, bytes: content }]);
});

it("lists the Tools House lists to the User's own agent as its help, and never sends the Kit credential", async () => {
  const house = await startHouse();
  const home = await connected(house, true);

  const ran = await runHouse(home, ['--help']);

  expect(ran.status).toBe(0);
  for (const tool of LISTING) expect(ran.stdout).toContain(helpLine(tool));
  expect(house.requests.map((request) => request.headers.authorization)).toEqual(['Bearer ahp_own']);
});

it("refuses a Tool call in one line naming kit login while Kit holds no connection for the User's own agent", async () => {
  const house = await startHouse();
  const home = await connected(house, false);

  const ran = await runHouse(home, ['search', '{"query":"invoice"}']);

  expect(ran.status).toBe(1);
  expect(ran.stdout).toBe('');
  expect(ran.stderr).toMatch(/^house: [^\n]*kit login[^\n]*\n$/);
  expect(house.requests).toEqual([]);
});

it("refuses a Tool call naming kit login once kit logout has ended the User's own agent's connection with the Kit's", async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  house.route('POST', '/kit/logout', () => ({ body: {} }));

  expect(await runKit(['logout'], { HOUSE_KIT_HOME: home }).exited).toBe(0);
  const ran = await runHouse(home, ['search', '{"query":"invoice"}']);

  expect(house.requests.map(({ path, headers, body }) => ({ path, authorization: headers.authorization, body }))).toEqual([
    { path: '/kit/logout', authorization: 'Bearer ahk_kit', body: {} },
  ]);
  await expect(access(join(home, 'own-agent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(ran.status).toBe(1);
  expect(ran.stderr).toMatch(/^house: [^\n]*kit login[^\n]*\n$/);
});

it("never falls back to the User's own agent's connection when a conversation's bridge is gone", async () => {
  const house = await startHouse();
  const home = await connected(house, true);

  const ran = await runHouse(home, ['search', '{"query":"invoice"}'], join(home, 'bridges', 'gone.sock'));

  expect(ran.status).toBe(1);
  expect(ran.stderr).toBe("house: this conversation's House connection is closed; nothing to do from here\n");
  expect(house.requests).toEqual([]);
});

it('tells an Agent whose CLI sandbox refuses the bridge to run house directly', async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  const socket = join(home, 'sandboxed.sock');
  const bridge = createServer((connection) => connection.end());
  bridge.listen(socket);
  await once(bridge, 'listening');
  await chmod(socket, 0);

  const ran = await runHouse(home, ['search', '{"query":"invoice"}'], socket);
  bridge.close();

  expect(ran.status).toBe(1);
  expect(ran.stderr).toBe(
    "house: your CLI's sandbox kept house from House; run house directly, not through another program\n",
  );
  expect(house.requests).toEqual([]);
});

it('prints the same help for house help as for house --help, listing help and push, a Tool without a description by its name alone, and no Git verb', async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    return { body: { jsonrpc: '2.0', id: message.id, result: { tools: [...LISTING, { name: 'about_house', inputSchema: { type: 'object' } }] } } };
  });

  const help = await runHouse(home, ['help']);
  const dashed = await runHouse(home, ['--help']);

  expect(help).toEqual(dashed);
  expect(help.status).toBe(0);
  const lines = help.stdout.split('\n');
  expect(lines.slice(0, 3)).toEqual([
    "usage: house <tool> ['<arguments as JSON>']",
    'help',
    "push [commit]: sends the Local copy's committed changes to House",
  ]);
  expect(lines).toContain('about_house');
  expect(help.stdout).not.toMatch(/\bgit\b/);
  expect((await runHouse(home, ['about_house', '--help'])).stdout).toBe('{"type":"object"}\n');
});

it("exits with the status House's shell answer names, and 0 when it names none", async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    const failed = message.params.arguments?.command === 'ls /rooms/private/house';
    return { body: { jsonrpc: '2.0', id: message.id, result: failed ? shelled('', 2, ['ls: path_not_found /rooms/private/house']) : shelled('ROOM.md') } };
  });

  const failed = await runHouse(home, ['shell', '{"command":"ls /rooms/private/house"}']);
  const listed = await runHouse(home, ['shell', '{"command":"ls /rooms/private"}']);

  expect(failed).toEqual({ status: 2, stdout: 'exit: 2\nstderr: ls: path_not_found /rooms/private/house\n', stderr: '' });
  expect(listed).toEqual({ status: 0, stdout: 'ROOM.md\n', stderr: '' });
});
