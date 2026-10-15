#!/usr/bin/env node
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 14)) {
  process.stderr.write(`house: the Kit needs Node 24.14.0 or newer; this is ${process.versions.node}\n`);
  process.exitCode = 1;
} else {
  await import('./house-cli.ts');
}
