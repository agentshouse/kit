export const HELP_META = 'agents.house/help';

type Schema = Record<string, unknown>;

type Example = Record<string, unknown>;

export type Help = { inputSchema: Schema; example: Example } | { inputSchema: Schema; ops: Record<string, { inputSchema: Schema; example: Example }> };

export interface Listed {
  name: string;
  title: string;
  description?: string;
  inputSchema: Schema;
  _meta: { [HELP_META]: Help };
}

const LONG = { type: 'boolean', description: '`true` raises the limit of a cut answer from 2 KB to 100 KB.' };

const PATH = { type: 'string', minLength: 1, description: 'The document or attachment.' };

const BASE = { type: 'string', minLength: 1, maxLength: 64, description: 'The `v_` revision you read.' };

const CURSOR = { type: 'string', minLength: 1, maxLength: 4096, description: 'The `next_cursor` of the answer before.' };

const UUID = { type: 'string', format: 'uuid', pattern: '^[0-9a-f-]{36}$' };

function object(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false };
}

function family(ops: Record<string, { inputSchema: Schema; example: Example }>, description: string): Help {
  return { inputSchema: object({ op: { type: 'string', enum: Object.keys(ops), description }, long: LONG }, ['op']), ops };
}

function tool(name: string, title: string, help: Help, description?: string): Listed {
  return { name, title, ...(description === undefined ? {} : { description }), inputSchema: help.inputSchema, _meta: { [HELP_META]: help } };
}

export const LISTING: Listed[] = [
  tool(
    'shell',
    'Read Rooms',
    {
      inputSchema: object(
        {
          command: { type: 'string', minLength: 1, maxLength: 16000, description: 'The command line.' },
          cwd: { type: 'string', minLength: 1, description: 'Starting directory; default `/`.' },
          long: LONG,
        },
        ['command'],
      ),
      example: { command: 'rg -n "deadline" /rooms/team-notes' },
    },
    'Read-only shell over `/rooms/<handle>`.',
  ),
  tool(
    'info',
    'Show details',
    {
      inputSchema: object({
        path: { type: 'string', minLength: 1, description: 'Any link or reference.' },
        history: { type: 'boolean', description: '`true` lists its revisions, newest first.' },
        cursor: CURSOR,
        long: LONG,
      }),
      example: { path: '/rooms/team-notes/plan.md' },
    },
    'Details of whatever `path` names.',
  ),
  tool('update', 'Change documents', {
    inputSchema: object(
      {
        changes: { minItems: 1, maxItems: 10000, type: 'array', items: {}, description: 'The changes, each with an `op`, applied all or none.' },
        mount: { type: 'string', minLength: 1, description: 'An empty folder; every change creates a document in it, all or none.' },
        long: LONG,
      },
      ['changes'],
    ),
    ops: {
      write: {
        inputSchema: object({ path: PATH, content: { type: 'string', description: 'The document’s whole text.' }, base: BASE }, ['path', 'content']),
        example: { changes: [{ op: 'write', path: '/rooms/team-notes/plan.md', content: '# Plan\n\nShip the beta on Friday.\n' }] },
      },
      move: {
        inputSchema: object(
          {
            path: PATH,
            to: { type: 'string', minLength: 1, description: 'The new path; links to it follow.' },
            base: {
              anyOf: [
                { type: 'string', minLength: 1, maxLength: 64 },
                { type: 'object', propertyNames: { type: 'string', minLength: 1 }, additionalProperties: { type: 'string', minLength: 1, maxLength: 64 } },
              ],
              description: 'The `v_` revision you read; a folder’s `move` takes `{name: revision}`.',
            },
          },
          ['path', 'to'],
        ),
        example: { changes: [{ op: 'move', path: '/rooms/team-notes/plan.md', to: '/rooms/team-notes/archive/plan.md' }] },
      },
      delete: {
        inputSchema: object({ path: PATH, base: BASE }, ['path']),
        example: { changes: [{ op: 'delete', path: '/rooms/team-notes/draft.md', base: 'v_4t.3.b' }] },
      },
    },
  }),
  tool(
    'upload',
    'Upload an attachment',
    {
      inputSchema: object(
        {
          file: {
            anyOf: [
              { type: 'string', minLength: 1 },
              object({ download_url: { type: 'string', format: 'uri' }, file_id: { type: 'string', minLength: 1 } }, ['download_url', 'file_id']),
            ],
            description: 'The file in your Environment, or a file from the chat; omit it for the link.',
          },
          path: { type: 'string', minLength: 1, description: 'Its path, `/rooms/<handle>/…`; with no file, the folder.' },
          long: LONG,
        },
        ['path'],
      ),
      example: { path: '/rooms/team-notes/photos' },
    },
    'Store a file at a path in a Room as an attachment.',
  ),
  tool(
    'guide',
    'Read the Guide',
    family(
      {
        open: {
          inputSchema: object({
            paths: { minItems: 1, type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'The pages `open` answers; none for `index`.' },
            cursor: CURSOR,
          }),
          example: { op: 'open', paths: ['reference/triggers'] },
        },
        search: {
          inputSchema: object({ query: { type: 'string', minLength: 1, maxLength: 256, description: 'Words in the pages you want.' }, cursor: CURSOR }, ['query']),
          example: { op: 'search', query: 'time zone' },
        },
      },
      '`open` or `search`.',
    ),
    'House’s guides and formats.',
  ),
  tool(
    'agent_update',
    'Change Agents and conversations',
    family(
      {
        create: {
          inputSchema: object(
            {
              environment: { ...UUID, description: 'Its Environment.' },
              cli: { type: 'string', enum: ['claude-agent-acp', 'codex-acp', 'grok-build'], description: 'Its CLI.' },
              model: { type: 'string', minLength: 1, description: 'Its model as the CLI names it.' },
              compaction_threshold: {
                anyOf: [{ type: 'integer', exclusiveMinimum: 0, maximum: 2147483647 }, { type: 'null' }],
                description: 'The context past which House compacts a conversation; null for never.',
              },
            },
            ['environment', 'model'],
          ),
          example: { op: 'create', environment: '0199c5fd-aeeb-7757-a9fa-e923d5a4fd12', cli: 'claude-agent-acp', model: 'opus' },
        },
        request_send: {
          inputSchema: object(
            {
              room: { type: 'string', minLength: 1, maxLength: 200, description: 'The Room, by handle or `r_…` ref.' },
              agent_function: { type: 'string', pattern: '^[^/]+$', description: 'The name of one of the Room’s `house/agent-functions/` cards.' },
              payload: { type: 'string', description: 'The Agent run’s input.' },
              copy: { type: 'string', enum: ['none', 'new', 'existing'], description: 'Whether its run works in a copy of the Room.' },
            },
            ['room', 'payload'],
          ),
          example: { op: 'request_send', room: 'team-notes', agent_function: 'triage', payload: 'Sort the new tasks by due date.' },
        },
        conversation_send: {
          inputSchema: object(
            {
              conversation: { ...UUID, description: 'The conversation; for `mail`, one from `agent` `conversations`.' },
              text: { type: 'string', minLength: 1, maxLength: 100000, description: '`mail`: the mail; `conversation_send`: the message.' },
            },
            ['conversation', 'text'],
          ),
          example: { op: 'conversation_send', conversation: '0199c58f-219e-7cb0-bb53-f16947ccf25e', text: "Summarise what's changed today." },
        },
      },
      '`create` an Agent, `request_send` a Run, `conversation_send` a message.',
    ),
  ),
];

export function listed(params: { _meta?: Record<string, unknown> }): { tools: unknown[] } {
  const help = params._meta?.[HELP_META] !== undefined;
  return { tools: help ? LISTING : LISTING.map(({ _meta: _help, ...plain }) => plain) };
}
