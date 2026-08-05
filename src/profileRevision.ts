import { createHash } from 'node:crypto';
import type { EventProfile } from './config';

/**
 * Identifies the part of an event profile that defines persisted answer keys.
 * User-facing text and fixed coordinates deliberately do not participate: they
 * can change without changing how an answer record is interpreted.
 */
export function eventProfileQuestionSchemaRevision(profile: EventProfile): string {
  const schema = {
    questions: profile.questions.map((question) => ({
      key: question.key,
      type: question.type,
      required: question.required,
      choices: question.choices.map((choice) => choice.id)
    })),
    startsAtDateQuestionKey: profile.startsAtDateQuestionKey,
    startsAtTimeQuestionKey: profile.startsAtTimeQuestionKey,
    location: profile.location.source === 'question'
      ? { source: 'question' as const, questionKey: profile.location.questionKey }
      : { source: 'fixed' as const }
  };
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}
