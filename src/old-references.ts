import { ATTACHMENT_REFERENCE_PREFIX, DOCUMENT_REFERENCE_PREFIX, REVISION_REFERENCE_PREFIX } from '@agentshouse/mdmodel';
import { isDocument } from './binaries.ts';

interface Held {
  manifests: Record<string, { files: Record<string, string | null> }>;
  push?: {
    changes: { op: string; path: string; base?: unknown }[];
    written?: { path: string; revision: string | null }[];
  };
}

const OLD_REVISION = 'fr_';
const OLD_ENTRY = 'af_';
const REVISION_BASES = new Set(['replace', 'remove', 'rename', 'upload']);

function renamed(value: string | null, path: string): string | null {
  if (value?.startsWith(OLD_REVISION)) return `${REVISION_REFERENCE_PREFIX}${value.slice(OLD_REVISION.length)}`;
  if (value?.startsWith(OLD_ENTRY)) {
    return `${isDocument(path) ? DOCUMENT_REFERENCE_PREFIX : ATTACHMENT_REFERENCE_PREFIX}${value.slice(OLD_ENTRY.length)}`;
  }
  return value;
}

export function renameOldReferences(record: Held): boolean {
  const held = JSON.stringify(record);
  for (const manifest of Object.values(record.manifests)) {
    for (const [path, revision] of Object.entries(manifest.files)) manifest.files[path] = renamed(revision, path);
  }
  for (const change of record.push?.changes ?? []) {
    if (REVISION_BASES.has(change.op) && typeof change.base === 'string') change.base = renamed(change.base, change.path);
  }
  for (const written of record.push?.written ?? []) written.revision = renamed(written.revision, written.path);
  return JSON.stringify(record) !== held;
}
