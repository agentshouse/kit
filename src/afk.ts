import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { CLIS } from './clis.ts';
import type { GrokQuestions } from './grok.ts';

const NOBODY_THERE = 'Nobody is there to answer. Decide for yourself and go on.';

export const PLAN_APPROVED = { outcome: 'approved' };

function told(fields: string[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field, NOBODY_THERE]));
}

export function permissionAllowed({ options }: RequestPermissionRequest): RequestPermissionResponse {
  const option = options.find(({ kind }) => kind === 'allow_once') ?? options.find(({ kind }) => kind === 'allow_always');
  return { outcome: { outcome: 'selected', optionId: option!.optionId } };
}

export function formAnswered(kind: string, request: CreateElicitationRequest): CreateElicitationResponse {
  const fields = CLIS[kind]!.questionFields(request);
  return fields.length === 0 ? { action: 'decline' } : { action: 'accept', content: told(fields) };
}

export function grokQuestionAnswered({ questions }: GrokQuestions): object {
  return { outcome: 'accepted', answers: told(questions.map(({ question }) => question)) };
}
