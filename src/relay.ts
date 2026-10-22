import { setGlobalProxyFromEnv } from 'node:http';

declare module 'node:http' {
  function setGlobalProxyFromEnv(proxyEnv?: NodeJS.ProcessEnv): () => void;
}

const PROXY = /^https?_proxy$/i;
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

let selected: string | null | undefined;
let restoreProxy: (() => void) | undefined;

export function selectRelay(relay: string | undefined): void {
  selected = relay === undefined || relay === '' ? null : relay;
  proxyUnlessRelayed();
}

export function relayOrigin(): string | undefined {
  if (selected !== undefined) return selected ?? undefined;
  const ambient = process.env.HOUSE_KIT_RELAY;
  return ambient === undefined || ambient === '' ? undefined : ambient;
}

function unlessRelayed(): NodeJS.ProcessEnv {
  if (relayOrigin() === undefined) return { ...process.env };
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !PROXY.test(name)));
}

export function proxyUnlessRelayed(): void {
  restoreProxy?.();
  restoreProxy = setGlobalProxyFromEnv(unlessRelayed());
}

export function childEnvironment(): NodeJS.ProcessEnv {
  const environment = unlessRelayed();
  if (!Object.keys(environment).some((name) => PROXY.test(name))) return environment;
  const bypassed = [environment.NO_PROXY ?? environment.no_proxy, ...LOOPBACK].filter((entry) => entry !== undefined && entry !== '').join(',');
  return { ...environment, NO_PROXY: bypassed, no_proxy: bypassed };
}

export function relayed(target: string | URL): URL {
  const url = new URL(target);
  const relay = relayOrigin();
  if (relay === undefined) return url;
  const through = new URL(`${url.host}${url.pathname}${url.search}`, `${relay}/`);
  if (url.protocol === 'wss:' || url.protocol === 'ws:') through.protocol = 'wss:';
  return through;
}
