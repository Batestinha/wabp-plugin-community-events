import type { EventProfile } from './config';
import {
  EVENT_CARRIED_ANSWERS_KEY,
  normalizeNumberWords,
  replyWord,
  type CarriedEventAnswer,
  type CarriedEventAnswers,
  formatCarriedDate
} from './answerResilience';
import { eventDateAnswer, eventTimeAnswer, parseEventDateInput, parseEventTimeInput, type EventDateTimeParseOptions } from './datetime';
import { EVENT_EDIT_FIELDS_STEP_ID, eventEditFieldIds } from './flow';

export type EventEditRole = 'date' | 'time' | 'place' | 'type' | 'span' | 'end';

/** Field words accepted after "/event edit [event]". */
const ROLE_WORDS: Record<EventEditRole, string[]> = {
  date: ['dia', 'data', 'date', 'quando', 'day'],
  time: ['hora', 'horas', 'horario', 'horário', 'time', 'hour'],
  place: ['local', 'onde', 'sitio', 'sítio', 'lugar', 'place', 'where', 'location', 'localizacao', 'localização'],
  type: ['tipo', 'estilo', 'style', 'type', 'modalidade'],
  span: ['duracao', 'duração', 'span'],
  end: ['fim', 'end', 'termina']
};
const ROLE_BY_WORD = new Map(Object.entries(ROLE_WORDS)
  .flatMap(([role, words]) => words.map(word => [replyWord(word), role as EventEditRole] as const)));

export interface EventEditRequest {
  roles: EventEditRole[];
  /** Text after the field words, offered as that field's new answer. */
  value?: string | undefined;
}

/** Splits "/event edit Albarracín hora 15h" into the event query and the fields to change. */
export function parseEventEditRequest(args: string[]): { query: string; request?: EventEditRequest | undefined } {
  const tokens = args.map(arg => arg.trim()).filter(Boolean);
  const first = tokens.findIndex(token => ROLE_BY_WORD.has(replyWord(token)));
  if (first < 0) return { query: tokens.join(' ') };
  const roles: EventEditRole[] = [];
  let index = first;
  for (; index < tokens.length; index += 1) {
    const role = ROLE_BY_WORD.get(replyWord(tokens[index]!));
    if (!role) break;
    if (!roles.includes(role)) roles.push(role);
  }
  const value = tokens.slice(index).join(' ').trim();
  return { query: tokens.slice(0, first).join(' '), request: { roles, ...(value ? { value } : {}) } };
}

function questionStepId(profile: EventProfile, key: string): string {
  return `q-${profile.id}-${key}`;
}

function typeQuestionKey(profile: EventProfile): string | undefined {
  const choice = profile.questions.find(question => question.type === 'choice');
  return choice?.key ?? profile.questions.find(question => /tipo|type|estilo|style/iu.test(question.prompt))?.key;
}

/**
 * The live session data for an edit started with field words: the selected
 * fields, and the typed value as a suggestion at its own question.
 */
export function eventEditStart(
  profile: EventProfile,
  initialData: Record<string, unknown>,
  request: EventEditRequest | undefined,
  options: EventDateTimeParseOptions
): { data: Record<string, unknown>; fields?: string[] | undefined } {
  if (!request?.roles.length) return { data: initialData };
  const ids = eventEditFieldIds();
  const placeKey = profile.location.source === 'question' ? profile.location.questionKey : undefined;
  const fields = [...new Set(request.roles.flatMap((role): string[] => {
    if (role === 'date') return [profile.startsAtDateQuestionKey];
    if (role === 'time') return [profile.startsAtTimeQuestionKey];
    if (role === 'place') return placeKey ? [placeKey] : [];
    if (role === 'type') { const key = typeQuestionKey(profile); return key ? [key] : []; }
    if (role === 'span') return [ids.span];
    return [ids.end];
  }).filter(field => field.startsWith('__') || profile.questions.some(question => question.key === field)))];
  if (!fields.length) return { data: initialData };
  const data: Record<string, unknown> = { ...initialData, [EVENT_EDIT_FIELDS_STEP_ID]: fields };
  const role = request.roles.length === 1 ? request.roles[0] : undefined;
  const value = request.value?.trim();
  if (!role || !value) return { data, fields };
  let answer: Omit<CarriedEventAnswer, 'previous'> | undefined;
  if (role === 'date') {
    const parsed = parseEventDateInput(normalizeNumberWords(value), options);
    if (parsed.status === 'ok') answer = { stepId: questionStepId(profile, profile.startsAtDateQuestionKey), input: parsed.normalized,
      label: formatCarriedDate(parsed.date, options.locale), value: eventDateAnswer({ ...parsed, reference: undefined }) };
  } else if (role === 'time') {
    const parsed = parseEventTimeInput(value);
    if (parsed.status === 'ok') answer = { stepId: questionStepId(profile, profile.startsAtTimeQuestionKey), input: parsed.normalized,
      label: parsed.normalized, value: eventTimeAnswer(parsed) };
  } else if (role === 'place' && placeKey) {
    answer = { stepId: questionStepId(profile, placeKey), input: value, label: value, value };
  }
  if (!answer) return { data, fields };
  const previous = JSON.stringify(Object.hasOwn(initialData, answer.stepId) ? initialData[answer.stepId] ?? null : null);
  const record: CarriedEventAnswers = { version: 1, mode: 'suggest', sourceStepId: 'command', originalText: value,
    answers: [{ ...answer, previous }] };
  return { data: { ...data, [EVENT_CARRIED_ANSWERS_KEY]: record }, fields };
}
