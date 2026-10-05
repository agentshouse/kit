import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { startHouse, type House } from './double.ts';
import { LISTING, shelled, type McpCall } from './environment.ts';
import { temporaryHome } from './kit.ts';

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

it("lists the Tools House lists to the User's own agent as its help, and never sends the Kit credential", async () => {
  const house = await startHouse();
  const home = await connected(house, true);

  const ran = await runHouse(home, ['--help']);

  expect(ran.status).toBe(0);
  for (const tool of LISTING) expect(ran.stdout).toContain(`${tool.name}: ${tool.description}`);
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

it("never falls back to the User's own agent's connection when a conversation's bridge is gone", async () => {
  const house = await startHouse();
  const home = await connected(house, true);

  const ran = await runHouse(home, ['search', '{"query":"invoice"}'], join(home, 'bridges', 'gone.sock'));

  expect(ran.status).toBe(1);
  expect(ran.stderr).toBe("house: this conversation's House connection is closed; nothing to do from here\n");
  expect(house.requests).toEqual([]);
});
