import {
  apply,
  definitionAt,
  HOUSE_MODEL,
  HOUSE_TYPED_PATHS,
  parse,
  serialize,
  type Change,
  type Definition,
  type Document,
  type VerifiedModel,
} from '@agentshouse/mdmodel';

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

function applied(document: Document, changes: Change[], definition: Definition | undefined): string | null {
  const result = apply(document, changes, definition);
  return result.outcome === 'applied' ? serialize(result.document) : null;
}

export function readDocument(
  content: string,
  file: string,
  model: VerifiedModel,
): { document: Document; definition: Definition | undefined } | null {
  const definitions = definitionAt(model, file, HOUSE_TYPED_PATHS);
  const parsed = parse(content, file, definitions);
  if (!parsed.ok) return null;
  const { document } = parsed;
  const definition = definitions(document.type);
  const untyped =
    document.type === undefined && definitionAt(HOUSE_MODEL, file, HOUSE_TYPED_PATHS)(undefined) === undefined;
  return definition !== undefined || untyped ? { document, definition } : null;
}

function components(
  path: string,
  before: Document,
  after: Document,
  text: string,
  definition: Definition | undefined,
): Edit[] | null {
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
  return edits.length > 0 && applied(before, changes, definition) === text ? edits : null;
}

export function changed(
  path: string,
  file: string,
  base: string | undefined,
  before: string,
  after: string,
  model: VerifiedModel,
): Edit[] {
  if (!file.endsWith('.md')) return [{ op: 'replace', path, base, content: after }];
  const prior = readDocument(before, file, model);
  const next = readDocument(after, file, model);
  const structured =
    prior !== null && next !== null ? components(path, prior.document, next.document, after, prior.definition) : null;
  return structured ?? [{ op: 'replace', path, base, content: after }];
}
