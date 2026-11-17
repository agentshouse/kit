import {
  ATTACHMENT_REFERENCE_PATTERN,
  ATTACHMENT_REFERENCE_PREFIX,
  DOCUMENT_REFERENCE_PATTERN,
  DOCUMENT_REFERENCE_PREFIX,
  REVISION_REFERENCE_PATTERN,
  REVISION_REFERENCE_PREFIX,
} from '@agentshouse/mdmodel';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDocument } from './binaries.ts';
import { kitHome } from './home.ts';

interface Form {
  old: string;
  prefix: string;
  pattern: RegExp;
}

interface Held {
  manifests?: Record<string, { files: Record<string, string | null> }>;
  push?: {
    changes: { op: string; path: string; base?: unknown }[];
    written?: { path: string; revision: string | null }[];
  };
}

const REVISION: Form = { old: 'fr_', prefix: REVISION_REFERENCE_PREFIX, pattern: REVISION_REFERENCE_PATTERN };
const DOCUMENT: Form = { old: 'af_', prefix: DOCUMENT_REFERENCE_PREFIX, pattern: DOCUMENT_REFERENCE_PATTERN };
const ATTACHMENT: Form = { old: 'af_', prefix: ATTACHMENT_REFERENCE_PREFIX, pattern: ATTACHMENT_REFERENCE_PATTERN };
const REVISION_BASES = new Set(['replace', 'remove', 'rename', 'upload']);

function renamed(value: string | null, path: string): string | null {
  const form = [REVISION, isDocument(path) ? DOCUMENT : ATTACHMENT].find(({ old }) => value?.startsWith(old));
  if (value === null || form === undefined) return value;
  const named = `${form.prefix}${value.slice(form.old.length)}`;
  return form.pattern.test(named) ? named : value;
}

function convert(record: Held): void {
  for (const manifest of Object.values(record.manifests ?? {})) {
    for (const [path, revision] of Object.entries(manifest.files)) manifest.files[path] = renamed(revision, path);
  }
  for (const change of record.push?.changes ?? []) {
    if (REVISION_BASES.has(change.op) && typeof change.base === 'string') change.base = renamed(change.base, change.path);
  }
  for (const written of record.push?.written ?? []) written.revision = renamed(written.revision, written.path);
}

export async function renameOldReferences(): Promise<void> {
  const records = join(kitHome(), 'local-copies', 'rooms');
  for (const name of (await readdir(records).catch(() => [])).filter((entry) => entry.endsWith('.json'))) {
    const path = join(records, name);
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text === null) continue;
    const record = JSON.parse(text) as Held;
    const held = JSON.stringify(record);
    convert(record);
    const rewritten = JSON.stringify(record);
    if (rewritten === held) continue;
    const temporary = `${path}.${process.pid}`;
    await writeFile(temporary, rewritten, { mode: 0o600 });
    await rename(temporary, path);
  }
}
