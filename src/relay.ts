let selected: string | null | undefined;

export function selectRelay(relay: string | undefined): void {
  selected = relay === undefined || relay === '' ? null : relay;
}

function relayOrigin(): string | undefined {
  if (selected !== undefined) return selected ?? undefined;
  const ambient = process.env.HOUSE_KIT_RELAY;
  return ambient === undefined || ambient === '' ? undefined : ambient;
}

export function relayed(target: string | URL): URL {
  const url = new URL(target);
  const relay = relayOrigin();
  if (relay === undefined) return url;
  const through = new URL(`${url.host}${url.pathname}${url.search}`, `${relay}/`);
  if (url.protocol === 'wss:' || url.protocol === 'ws:') through.protocol = 'wss:';
  return through;
}
