import { readFile, writeFile } from 'node:fs/promises';

const SCRIPTS = {
  macos: 'connect-linux.sh',
  linux: 'connect-linux.sh',
  windows: 'connect-windows.ps1',
};

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const hosts = Object.fromEntries(
  Object.entries(SCRIPTS).map(([host, name]) => [
    host,
    { asset: { name, url: `https://github.com/agentshouse/kit/releases/download/v${version}/${name}` } },
  ]),
);
await writeFile(new URL('../dist/bootstrap.json', import.meta.url), `${JSON.stringify({ schemaVersion: 2, version, hosts }, null, 2)}\n`);
