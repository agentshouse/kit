import { readFile, writeFile } from 'node:fs/promises';

const SCRIPTS = {
  linux: {
    name: 'connect-linux.sh',
    command: (url) => `bash <(curl -fsSL ${url})`,
    workspace: { argument: '--workspace', quoting: 'posix' },
    container: { argument: '--container' },
  },
  windows: {
    name: 'connect-windows.ps1',
    command: (url) => `& ([scriptblock]::Create((irm ${url})))`,
    workspace: { argument: '--workspace', quoting: 'powershell' },
  },
};

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const hosts = Object.fromEntries(
  Object.entries(SCRIPTS).map(([host, { name, command, ...choices }]) => {
    const url = `https://github.com/agentshouse/kit/releases/download/v${version}/${name}`;
    return [host, { command: command(url), asset: { name, url }, ...choices }];
  }),
);
await writeFile(new URL('../dist/bootstrap.json', import.meta.url), `${JSON.stringify({ schemaVersion: 1, version, hosts }, null, 2)}\n`);
