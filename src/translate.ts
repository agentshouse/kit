import { apply, parse, serialize, type Change, type Document } from '@agentshouse/mdmodel';

export type Edit =
  | { op: 'create'; path: string; content: string }
  | { op: 'replace'; path: string; base: string | undefined; content: string }
  | { op: 'remove'; path: string; base: string | undefined }
  | { op: 'rename'; path: string; to: string; base: string | undefined }
  | { op: 'set_field'; path: string; field: string; base?: unknown; value: unknown }
  | { op: 'replace_section'; path: string; section: string; base: string; content: string }
  | { op: 'replace_preamble'; path: string; base: string; content: string };

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applied(document: Document, changes: Change[]): string | null {
  let current = document;
  for (const change of changes) {
    const result = apply(current, change);
    if (result.outcome !== 'applied') return null;
    current = result.document;
  }
  return serialize(current);
}

function components(path: string, before: Document, after: Document, text: string): Edit[] | null {
  const edits: Edit[] = [];
  const changes: Change[] = [];
  if (before.preamble !== after.preamble) {
    edits.push({ op: 'replace_preamble', path, base: before.preamble, content: after.preamble });
    changes.push({ kind: 'preamble', value: after.preamble, prior: before.preamble });
  }
  for (const name of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
    const prior = before.fields[name];
    const value = after.fields[name];
    if (same(prior, value)) continue;
    if (value === undefined) return null;
    edits.push({ op: 'set_field', path, field: name, ...(prior === undefined ? {} : { base: prior }), value });
    changes.push({ kind: 'field', name, value, prior });
  }
  for (const name of new Set([...Object.keys(before.sections), ...Object.keys(after.sections)])) {
    const prior = before.sections[name];
    const value = after.sections[name];
    if (prior === value) continue;
    if (prior === undefined || value === undefined) return null;
    edits.push({ op: 'replace_section', path, section: name, base: prior, content: value });
    changes.push({ kind: 'section', name, value, prior });
  }
  return edits.length > 0 && applied(before, changes) === text ? edits : null;
}

export function changed(path: string, file: string, base: string | undefined, before: string, after: string): Edit[] {
  const parsedBefore = parse(before, file);
  const parsedAfter = parse(after, file);
  const structured =
    parsedBefore.ok && parsedAfter.ok ? components(path, parsedBefore.document, parsedAfter.document, after) : null;
  return structured ?? [{ op: 'replace', path, base, content: after }];
}
