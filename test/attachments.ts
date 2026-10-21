import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { vi } from 'vitest';
import { stringify } from 'yaml';
import { socketDirectory } from '../src/home.ts';
import type { Received } from './double.ts';
import type { Hosted, McpCall } from './environment.ts';

export interface Attachment {
  name: string;
  media_type: string | null;
  content: Buffer;
}

export interface Attached {
  path: string;
  link: string;
  key: string;
}

export const ATTACHMENTS = '/rooms/private/attachments/2026-10-21';

export function link(path: string): string {
  return `[${path.slice(path.lastIndexOf('/') + 1)}](${path})`;
}

export function attached(hosted: Hosted, attachments: Attachment[], documents: string[] = [], refusals: Record<string, string> = {}): Attached[] {
  const held = new Map<string, Attachment & { key: string }>();
  const files = attachments.map((attachment, index) => {
    const path = `${ATTACHMENTS}/${attachment.name}`;
    const key = `binary/${index + 1}/${attachment.name}`;
    hosted.store.objects.set(key, attachment.content);
    held.set(path, { ...attachment, key });
    return { path, link: link(path), key };
  });
  hosted.tools.inspect = (args) => {
    const path = String(args.path);
    const refusal = refusals[path];
    if (refusal !== undefined) return { isError: true, content: [{ type: 'text', text: refusal }] };
    if (documents.includes(path)) {
      return { content: [{ type: 'text', text: stringify({ path, revision: 'rev-document', media_type: 'text/markdown' }) }] };
    }
    const file = held.get(path);
    if (file === undefined) return { isError: true, content: [{ type: 'text', text: `path_not_found: ${path} does not exist\n` }] };
    const text = stringify({
      path,
      revision: `rev-${file.key}`,
      file: `bf_${file.key}`,
      bytes: file.content.length,
      ...(file.media_type === null ? {} : { media_type: file.media_type }),
      sha256: createHash('sha256').update(file.content).digest('hex'),
      download: hosted.store.address('GET', file.key),
    });
    return { content: [{ type: 'text', text }] };
  };
  return files;
}

export function inspected(hosted: Hosted): unknown[] {
  return hosted.mcp
    .map((received: Received) => (received.body as McpCall).params)
    .filter((params) => params.name === 'inspect')
    .map((params) => params.arguments);
}

export async function bridgeSockets(hosted: Hosted): Promise<string[]> {
  vi.stubEnv('HOUSE_KIT_HOME', hosted.home);
  const sockets = socketDirectory();
  vi.unstubAllEnvs();
  return (await readdir(sockets)).filter((name) => name.endsWith('.sock') && name !== 'owner.sock');
}

export function posted(hosted: Hosted): unknown[] {
  return hosted.transcripts.map((received) => [received.params.conversation, received.params.message, received.body]);
}
