import { expect, it } from 'vitest';
import { grokQuestionAnswer, grokQuestionForm } from '../src/grok.ts';

const OPTIONS = [{ label: 'Red', description: 'The red one' }];

it('words a lone question once, in the form its surfaces show', () => {
  const form = grokQuestionForm({
    sessionId: 'session',
    questions: [{ question: 'Which colour?', options: OPTIONS, multiSelect: null }],
  });

  expect(form).toMatchObject({
    message: 'Which colour?',
    requestedSchema: { properties: { 'Which colour?': { title: 'Answer' } } },
  });
});

it.each([['cancel'], ['decline']])('tells Grok a form that came back %s was cancelled', (action) => {
  expect(grokQuestionAnswer({ action })).toEqual({ outcome: 'cancelled' });
});
