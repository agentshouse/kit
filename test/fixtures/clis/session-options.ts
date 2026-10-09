import type { SessionConfigOption } from '@agentclientprotocol/sdk';

export interface CliModel {
  id: string;
  name: string;
  efforts: string[];
}

type Choice = { value: string; name: string };
type Build = (models: CliModel[], model: string, effort: string, mode?: string) => SessionConfigOption[];

export const MODELS: Record<string, CliModel[]> = {
  'codex-acp': [
    { id: 'gpt-5.5', name: '5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-5.5-mini', name: '5.5 Mini', efforts: ['minimal', 'low', 'medium', 'high'] },
    { id: 'codex-instant', name: 'codex-instant', efforts: [] },
  ],
  'claude-agent-acp': [
    { id: 'default', name: 'Default (recommended)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'sonnet', name: 'Sonnet', efforts: ['low', 'medium', 'high', 'max'] },
    { id: 'haiku', name: 'Haiku', efforts: [] },
  ],
  'grok-build': [
    { id: 'grok-4.6', name: 'Grok 4.6', efforts: ['xhigh', 'high', 'medium', 'low'] },
    { id: 'grok-4.5', name: 'Grok 4.5', efforts: ['high', 'medium', 'low'] },
  ],
};

const capitalized = (level: string): Choice => ({ value: level, name: level.charAt(0).toUpperCase() + level.slice(1) });

function select(id: string, name: string, category: string, currentValue: string, options: Choice[]): SessionConfigOption {
  return { id, name, category, type: 'select', currentValue, options };
}

function modelOption(models: CliModel[], model: string): SessionConfigOption {
  return select('model', 'Model', 'model', model, models.map(({ id, name }) => ({ value: id, name })));
}

function effortOption(id: string, name: string, models: CliModel[], model: string, effort: string, first: Choice[] = []) {
  const levels = models.find((entry) => entry.id === model)?.efforts;
  if (levels?.length === 0) return [];
  return [select(id, name, 'thought_level', effort, [...first, ...(levels ?? []).map(capitalized)])];
}

export const SESSION_OPTIONS: Record<string, Build> = {
  'codex-acp': (models, model, effort, mode = 'agent') => [
    select('mode', 'Mode', 'mode', mode, [
      { value: 'read-only', name: 'Read-only' },
      { value: 'workspace-write', name: 'Workspace access' },
      { value: 'agent', name: 'Auto review' },
      { value: 'agent-full-access', name: 'Full access' },
    ]),
    select('collaboration_mode', 'Collaboration mode', 'collaboration_mode', 'default', [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
    ]),
    modelOption(models, model),
    ...effortOption('reasoning_effort', 'Reasoning effort', models, model, effort),
  ],
  'claude-agent-acp': (models, model, effort, mode = 'default') => [
    select('mode', 'Mode', 'mode', mode, [
      { value: 'default', name: 'Manual' },
      { value: 'acceptEdits', name: 'Accept edits' },
      { value: 'plan', name: 'Plan' },
      { value: 'auto', name: 'Auto' },
      { value: 'bypassPermissions', name: 'Bypass permissions' },
    ]),
    modelOption(models, model),
    ...effortOption('effort', 'Effort', models, model, effort, [{ value: 'default', name: 'Default' }]),
  ],
  'grok-build': (models, model, effort) => [
    modelOption(models, model),
    ...effortOption('reasoning_effort', 'Reasoning effort', models, model, effort),
  ],
};
