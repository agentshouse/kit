import { afterEach, expect, it, vi } from 'vitest';
import { certificate, startHouse, startProxy } from './double.ts';

const PROXIES = { HTTP_PROXY: 'http://proxy.example:3128', HTTPS_PROXY: 'http://proxy.example:3128', http_proxy: 'http://proxy.example:3128', https_proxy: 'http://proxy.example:3128' };

async function relay() {
  vi.resetModules();
  return import('../src/relay.ts');
}

afterEach(async () => {
  vi.unstubAllEnvs();
  (await relay()).proxyUnlessRelayed();
});

it('reaches House directly when no relay is named', async () => {
  const { relayed } = await relay();
  expect(relayed('https://dev.agents.house/kit/stream').href).toBe('https://dev.agents.house/kit/stream');
});

it('carries every House address through the named relay with its host first', async () => {
  vi.stubEnv('HOUSE_KIT_RELAY', 'https://relay.example');
  const { relayed } = await relay();
  expect(relayed('wss://dev.agents.house/kit/stream').href).toBe('wss://relay.example/dev.agents.house/kit/stream');
  expect(relayed('https://files.dev.agents.house/t/abc?x=1').href).toBe(
    'https://relay.example/files.dev.agents.house/t/abc?x=1',
  );
  expect(relayed('https://dev.agents.house/kit-installer/kit-0.2.1.tar.gz').href).toBe(
    'https://relay.example/dev.agents.house/kit-installer/kit-0.2.1.tar.gz',
  );
});

it("keeps the proxy variables for every process it starts when no relay is named, bypassing them only for the Kit's own loopback bridge", async () => {
  for (const [name, value] of Object.entries(PROXIES)) vi.stubEnv(name, value);
  vi.stubEnv('NO_PROXY', 'intranet.example');
  const { childEnvironment } = await relay();
  expect(childEnvironment()).toMatchObject({
    ...PROXIES,
    NO_PROXY: 'intranet.example,127.0.0.1,localhost,::1',
    no_proxy: 'intranet.example,127.0.0.1,localhost,::1',
  });
});

it.each([
  ['the environment names', (module: typeof import('../src/relay.ts')) => vi.stubEnv('HOUSE_KIT_RELAY', 'https://relay.example')],
  ['the enrolment records', (module: typeof import('../src/relay.ts')) => module.selectRelay('https://relay.example')],
])('removes the proxy variables from every process it starts when %s a relay', async (_case, select) => {
  for (const [name, value] of Object.entries(PROXIES)) vi.stubEnv(name, value);
  const module = await relay();
  select(module);
  const started = module.childEnvironment();
  expect(Object.keys(started).filter((name) => /^https?_proxy$/i.test(name))).toEqual([]);
  expect(started.PATH).toBe(process.env.PATH);
});

it('calls House through the proxy the variables name unless a relay is named, then directly', async () => {
  const proxy = await startProxy();
  const house = await startHouse(certificate());
  for (const name of Object.keys(PROXIES)) vi.stubEnv(name, proxy.origin);
  const module = await relay();

  module.proxyUnlessRelayed();
  await fetch(`${house.origin}/answer`).catch(() => undefined);
  const proxied = [...proxy.tunnels];
  module.selectRelay('https://relay.example');
  await fetch(`${house.origin}/answer`).catch(() => undefined);

  expect(proxied).toEqual([new URL(house.origin).host]);
  expect(proxy.tunnels).toEqual(proxied);
});
