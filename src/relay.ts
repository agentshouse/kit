export function relayed(target: string | URL): URL {
  const url = new URL(target);
  const relay = process.env.HOUSE_KIT_RELAY;
  if (relay === undefined || relay === '') return url;
  const through = new URL(`${url.host}${url.pathname}${url.search}`, `${relay}/`);
  if (url.protocol === 'wss:' || url.protocol === 'ws:') through.protocol = 'wss:';
  return through;
}
