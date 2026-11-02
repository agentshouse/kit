import type { CreateElicitationRequest, CreateElicitationResponse, ElicitationPropertySchema } from '@agentclientprotocol/sdk';

interface GrokQuestion {
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean | null;
}

export interface GrokQuestions {
  sessionId: string;
  questions: GrokQuestion[];
}

export interface GrokPlan {
  sessionId: string;
  planContent: string;
}

const PLAN = 'plan';

const PLAN_ABANDONED = 'abandoned';

const PLAN_FIELD: ElicitationPropertySchema = {
  type: 'string',
  title: 'Approve this plan?',
  oneOf: [
    { const: 'approved', title: 'Approve' },
    { const: PLAN_ABANDONED, title: 'Abandon' },
  ],
};

function form(sessionId: string, message: string, properties: Record<string, ElicitationPropertySchema>): CreateElicitationRequest {
  return { mode: 'form', sessionId, message, requestedSchema: { type: 'object', properties } };
}

function questionField({ options, multiSelect }: GrokQuestion, title: string): ElicitationPropertySchema {
  const choices = options.map(({ label, description }) => ({ const: label, title: label, description }));
  return multiSelect === true ? { type: 'array', title, items: { anyOf: choices } } : { type: 'string', title, oneOf: choices };
}

export function grokQuestionForm({ sessionId, questions }: GrokQuestions): CreateElicitationRequest {
  const lone = questions.length === 1;
  return form(
    sessionId,
    questions.map(({ question }) => question).join('\n\n'),
    Object.fromEntries(questions.map((one) => [one.question, questionField(one, lone ? 'Answer' : one.question)])),
  );
}

function answerText(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function contentOf(response: CreateElicitationResponse): Record<string, unknown> {
  return response.action === 'accept' ? ((response.content ?? {}) as Record<string, unknown>) : {};
}

export function grokQuestionAnswer(response: CreateElicitationResponse): object {
  if (response.action !== 'accept') return { outcome: 'cancelled' };
  const answers = Object.entries(contentOf(response)).map(([question, value]) => [question, answerText(value)]);
  return { outcome: 'accepted', answers: Object.fromEntries(answers) };
}

export function grokPlanForm({ sessionId, planContent }: GrokPlan): CreateElicitationRequest {
  return form(sessionId, planContent, { [PLAN]: PLAN_FIELD });
}

export function grokPlanAnswer(response: CreateElicitationResponse): object {
  return { outcome: contentOf(response)[PLAN] ?? PLAN_ABANDONED };
}
