import {
  parseValueTemplate, valueTemplateReferences, renameValueTemplateToken, renderValueTemplate, renderValueTemplateText, validateValueTemplate,
  previewTemplateFragment, type TemplateConditionVariable, type TemplateScalar, type TemplateFragment,
  type ValueTemplateDefinition
} from '@wabs/plugin-sdk/templates';
import type { EventProfile } from './config';
export { ValueTemplateError as EventTemplateSyntaxError, parseValueTemplate as parseEventTemplate,
  renameValueTemplateToken as renameEventTemplateToken } from '@wabs/plugin-sdk/templates';
export type { ValueTemplateNode as EventTemplateNode, TemplateValidationIssue as EventTemplateValidationIssue } from '@wabs/plugin-sdk/templates';
export const eventMessageMentions = { people: true, groups: true, all: true,
  targets: [{ id: 'creator', label: 'Event creator' }, { id: 'currentGroup', label: 'Current group' }] };
const numericTokens = new Set(['temperatureMax', 'temperatureMin', 'precipitation', 'precipitationProbability', 'windSpeed', 'windGust', 'windDirection', 'weatherCode']);
export function eventTemplateFields(tokens: Iterable<string>, profile?: Pick<EventProfile, 'questions'>): TemplateConditionVariable[] {
  return [...new Set(tokens)].map(token => {
    const question = profile?.questions.find(item => item.key === token);
    if (question?.type === 'choice') return { token, label: question.prompt || token, valueType: 'enum', optional: !question.required,
      options: question.choices.map(choice => ({ value: choice.id, label: choice.label })) };
    if (token === 'spanKind') return { token, label: 'Duration type', valueType: 'enum', options: [
      { value: 'day_trip', label: 'Day trip' }, { value: 'multi_day', label: 'Multiple days' }] };
    return { token, label: token, valueType: token === 'isMultiDay' ? 'boolean' : numericTokens.has(token) ? 'number' : 'text', optional: token !== 'isMultiDay' };
  });
}
export function eventTemplateDefinition(tokens: Iterable<string>, profile?: Pick<EventProfile, 'questions'>, body = false, activation: ValueTemplateDefinition['activation'] = 'always'): ValueTemplateDefinition {
  return { variables: eventTemplateFields(tokens, profile), activation, ...(body ? { mentions: eventMessageMentions } : {}) };
}
export function validateEventTemplateText(source: string, tokens: Iterable<string>) { return validateValueTemplate(source, eventTemplateDefinition(tokens)); }
export function validateEventConditionalText(source: string, tokens: Iterable<string>) { return validateValueTemplate(source, eventTemplateDefinition(tokens, undefined, false, 'when-used')); }
export function validateEventTemplateSyntax(source: string) { try { parseValueTemplate(source); return []; } catch (error) { return [{ message: String(error) }]; } }
export function renderEventTemplateText(source: string, values: Readonly<Record<string, string | undefined>>): string {
  return renderValueTemplateText(source, eventTemplateDefinition([...Object.keys(values), ...valueTemplateReferences(source).tokens]), { displayValues: values });
}
export type EventConditionalTextFailureCode = 'invalid-template' | 'rendered-empty' | 'rendered-too-long' | 'duplicate-rendered-values';
export class EventConditionalTextConfigurationError extends Error {
  constructor(readonly field: string, readonly code: EventConditionalTextFailureCode) {
    super(`Event conditional text configuration failed for ${field}: ${code}`); this.name = 'EventConditionalTextConfigurationError';
  }
}
export interface EventConditionalTextInput {
  source: string; allowedTokens: Iterable<string>; values: Readonly<Record<string, string | undefined>>;
  conditionValues?: Readonly<Record<string, TemplateScalar | undefined>> | undefined;
  profile?: Pick<EventProfile, 'questions'> | undefined; body?: boolean | undefined;
  emptyResult: 'reject' | 'suppress'; field: string; maxLength?: number | undefined;
}
export function renderEventConditionalFragment(input: EventConditionalTextInput): TemplateFragment {
  let result: TemplateFragment;
  try { result = renderValueTemplate(input.source, eventTemplateDefinition(input.allowedTokens, input.profile, input.body, 'when-used'), {
    displayValues: input.values, conditionValues: input.conditionValues }); }
  catch { throw new EventConditionalTextConfigurationError(input.field, 'invalid-template'); }
  const preview = previewTemplateFragment(result);
  if (!preview.trim() && input.emptyResult === 'reject') throw new EventConditionalTextConfigurationError(input.field, 'rendered-empty');
  if (input.maxLength !== undefined && [...preview].length > input.maxLength) throw new EventConditionalTextConfigurationError(input.field, 'rendered-too-long');
  return result;
}
export function renderEventConditionalText(input: EventConditionalTextInput): string | undefined {
  const fragment = renderEventConditionalFragment(input);
  if (fragment.segments.some(segment => segment.kind === 'mention')) throw new EventConditionalTextConfigurationError(input.field, 'invalid-template');
  return previewTemplateFragment(fragment) || undefined;
}
export function renameEventConditionalTextToken(source: string, oldToken: string, newToken: string, _allowedTokens: Iterable<string>): string {
  return renameValueTemplateToken(source, oldToken, newToken);
}
/** Canonical IDs win. Older labels are backfilled only when exactly one current choice matches. */
export function eventRawAnswers(profile: Pick<EventProfile, 'questions'>, answers: Record<string, string>, saved?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const question of profile.questions) {
    const value = answers[question.key];
    if (value === undefined) continue;
    if (question.type !== 'choice') { result[question.key] = saved?.[question.key] ?? value; continue; }
    if (saved) { if (Object.hasOwn(saved, question.key)) result[question.key] = saved[question.key]!; continue; }
    const matches = question.choices.filter(choice => choice.label === value);
    if (matches.length === 1) result[question.key] = matches[0]!.id;
  }
  return result;
}
