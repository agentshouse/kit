#!/usr/bin/env node
const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && (minor < 22 || (minor === 22 && patch < 1)))) {
  process.stderr.write(`kit: the Kit needs Node 24.22.1 or newer; this is ${process.versions.node}\n`);
  process.exitCode = 1;
} else {
  await import('./kit-cli.ts');
}
