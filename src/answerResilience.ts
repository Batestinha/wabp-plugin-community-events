import { chronoParserForLocale } from '@wabs/plugin-sdk/chrono-locale';
import { flowSavedAnswer } from '@wabs/plugin-sdk/flow-input';
import type {
  FlowState,
  FlowStep,
  FlowStepInputHandlerResult,
  FlowStepInputResolutionInput
} from '@wabs/plugin-sdk/flow-types';
import {
  eventLocalDateTimeParts,
  formatEventDateParts,
  formatEventTimeParts,
  parseEventDateTimeInput,
  parseEventTimeInput,
  type EventDateParts,
  type EventDateTimeParseOptions,
  type EventTimeParts
} from './datetime';

/**
 * Answers that a member typed before the question that owns them was asked,
 * such as "Sintra dia 4 de novembro" at "Where?". The record lives in flow
 * data next to the step answers and is never a step answer itself:
 * - `suggest`: the whole reply belonged to later questions; each one offers it.
 * - `split`: the member accepted a split, so the carried answers apply for as
 *   long as the source step still holds the proposed value and the target
 *   steps have not been answered since.
 */
export const EVENT_CARRIED_ANSWERS_KEY = '__eventCarriedAnswers';

export interface CarriedEventAnswer {
  stepId: string;
  /** Canonical answer text, re-validated by the owning step when accepted. */
  input: string;
  label: string;
  value: unknown;
  /** JSON of the target step's value when the answer was carried. */
  previous: string;
}

export interface CarriedEventAnswers {
  version: 1;
  mode: 'suggest' | 'split';
  sourceStepId: string;
  originalText: string;
  proposedValue?: string | undefined;
  answers: CarriedEventAnswer[];
}

export function carriedEventAnswers(data: Record<string, unknown>): CarriedEventAnswers | undefined {
  const value = data[EVENT_CARRIED_ANSWERS_KEY] as Partial<CarriedEventAnswers> | undefined;
  return value && value.version === 1 && (value.mode === 'suggest' || value.mode === 'split')
    && typeof value.sourceStepId === 'string' && Array.isArray(value.answers)
    ? value as CarriedEventAnswers : undefined;
}

function stepValueJson(data: Record<string, unknown>, stepId: string): string {
  return JSON.stringify(Object.hasOwn(data, stepId) ? data[stepId] ?? null : null);
}

function carriedAnswerStillApplies(data: Record<string, unknown>, answer: CarriedEventAnswer): boolean {
  return stepValueJson(data, answer.stepId) === answer.previous;
}

function splitIsActive(data: Record<string, unknown>, carried: CarriedEventAnswers): boolean {
  return carried.mode === 'split' && typeof carried.proposedValue === 'string'
    && data[carried.sourceStepId] === carried.proposedValue;
}

/** Step ids whose answers come from an accepted split instead of their own question. */
export function eventStepsAnsweredBySplit(data: Record<string, unknown>): Set<string> {
  const carried = carriedEventAnswers(data);
  if (!carried || !splitIsActive(data, carried)) return new Set();
  return new Set(carried.answers.filter(answer => carriedAnswerStillApplies(data, answer)).map(answer => answer.stepId));
}

/** Flow data with accepted split answers applied; every reader of answers goes through this. */
export function effectiveEventFlowData(data: Record<string, unknown>): Record<string, unknown> {
  const carried = carriedEventAnswers(data);
  if (!carried || !splitIsActive(data, carried)) return data;
  const effective = { ...data };
  for (const answer of carried.answers) {
    if (carriedAnswerStillApplies(data, answer)) effective[answer.stepId] = answer.value;
  }
  return effective;
}

/** A suggestion is shown at its own question until that question is answered. */
export function carriedEventSuggestion(data: Record<string, unknown>, stepId: string): CarriedEventAnswer | undefined {
  const carried = carriedEventAnswers(data);
  if (!carried) return undefined;
  if (carried.mode === 'split' && !splitIsActive(data, carried)) return undefined;
  return carried.answers.find(answer => answer.stepId === stepId && carriedAnswerStillApplies(data, answer));
}

// ---------------------------------------------------------------------------
// Reply words

export function replyWord(input: string): string {
  return input.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    .replace(/^\/+/, '').replace(/[\s.!?¡¿,;:]+$/u, '').replace(/\s+/g, ' ');
}

const wordSet = (...words: string[]) => new Set(words.map(replyWord));
const KEEP_WORDS = wordSet('keep', 'manter', 'mantem', 'mantém', 'mantenho', 'manter isso', 'igual', 'fica igual', 'o mesmo',
  'a mesma', 'mesmo', 'mesma', 'same', 'unchanged', 'sem alteracoes', 'sem alteração', 'nao mudar', 'não mudar', 'inalterado');
const SKIP_WORDS = wordSet('skip', 'saltar', 'salta', 'ignorar', 'ignora', 'pular', 'passar', 'nenhum', 'nenhuma', 'nada',
  'none', 'sem hora', 'n/a', 'nao sei', 'não sei', 'no time');
const ACCEPT_WORDS = wordSet('ok', 'okay', 'okey', 'oki', 'sim', 's', 'yes', 'y', 'yep', 'yeah', 'isso', 'isso mesmo', 'certo',
  'correto', 'confirmo', 'confirmar', 'pode ser', 'perfeito', 'exato', 'exatamente', 'sure', 'correct', '1', '👍', '✅');
const REJECT_WORDS = wordSet('nao', 'não', 'n', 'no', 'nope', 'errado', 'manter nome', 'manter o nome', 'e o nome', 'é o nome',
  'keep name', 'keep the name', 'its the name', 'it is the name', '2');
const CANCEL_WORDS = wordSet('cancel', 'cancelar', 'cancela', 'stop', 'parar', 'sair', 'exit', 'quit', 'desistir');
const BACK_WORDS = wordSet('back', 'voltar', 'volta', 'atras', 'atrás', 'voltar atras', 'voltar atrás', 'anterior', 'retroceder');

export type EventReplyControl = 'keep' | 'skip' | 'accept' | 'reject' | 'cancel' | 'back';

export function eventReplyControl(input: string): EventReplyControl | undefined {
  const raw = input.trim();
  if (raw === '👍' || raw === '✅') return 'accept';
  const word = replyWord(raw);
  if (!word) return undefined;
  if (KEEP_WORDS.has(word)) return 'keep';
  if (SKIP_WORDS.has(word)) return 'skip';
  if (ACCEPT_WORDS.has(word)) return 'accept';
  if (REJECT_WORDS.has(word)) return 'reject';
  if (CANCEL_WORDS.has(word)) return 'cancel';
  if (BACK_WORDS.has(word)) return 'back';
  return undefined;
}

// ---------------------------------------------------------------------------
// Number words ("daqui a dois dias")

const NUMBER_WORDS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezasseis: 16, dezesseis: 16, dezassete: 17,
  dezessete: 17, dezoito: 18, dezanove: 19, dezenove: 19, vinte: 20, trinta: 30,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, a: 1, an: 1
};
const UNIT = String.raw`(?:dias?|semanas?|mes(?:es)?|mês|days?|weeks?|months?)`;

function numberWordValue(word: string): number | undefined {
  return NUMBER_WORDS[word.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()];
}

/** Rewrites counted durations so the date parser sees digits: "dois dias" -> "2 dias". */
export function normalizeNumberWords(input: string): string {
  const compound = new RegExp(String.raw`\b(vinte|trinta|twenty|thirty)\s+(?:e\s+|-)?(\p{L}+)(?=\s+${UNIT}\b)`, 'giu');
  let output = input.replace(compound, (match, tens: string, units: string) => {
    const value = (numberWordValue(tens) ?? 0) + (numberWordValue(units) ?? Number.NaN);
    return Number.isFinite(value) && (numberWordValue(units) ?? 0) < 10 ? String(value) : match;
  });
  output = output.replace(new RegExp(String.raw`(^|[^\p{L}])(\p{L}+)(?=\s+${UNIT}\b)`, 'giu'), (match, prefix: string, word: string) => {
    const value = numberWordValue(word);
    // "a"/"an" count only in English ("in a week"); Portuguese "a" is a preposition.
    if (value === undefined || (/^(a|an)$/i.test(word) && !/\bin\s*$/i.test(input.slice(0, input.indexOf(match) + prefix.length)))) return match;
    return `${prefix}${value}`;
  });
  return output;
}

// ---------------------------------------------------------------------------
// Dates and times inside free-text answers

export interface EmbeddedDateTimeFragment {
  start: number;
  end: number;
  text: string;
  date?: EventDateParts | undefined;
  time?: EventTimeParts | undefined;
  relative: boolean;
  /** Written as a date on its own terms ("dia 8", "2026-11-07"), never as part of a name. */
  explicit?: boolean | undefined;
  /** A bare weekday such as "Domingo", which is common inside place names. */
  weekdayOnly?: boolean | undefined;
}

export interface EmbeddedDateTime {
  fragments: EmbeddedDateTimeFragment[];
  /** The answer with the fragments and their connecting words removed. */
  remainder: string;
  /** True when the fragments are clearly an appended date rather than part of a name. */
  strong: boolean;
  /** True when nothing but the date or time was typed. */
  whole: boolean;
  date?: EventDateParts | undefined;
  time?: EventTimeParts | undefined;
}

const CONNECTOR_BEFORE_MARKER = /(^|[\s,;])(?:no dia|na|no|dia|em|a|às|as|pelas|pela|para|on|at|the|in|for|by|e|and|até|ate|de|do|da)\s*\u0000/iu;
const STRONG_BEFORE = /(?:(?:^|[\s,;])(?:no dia|dia|em|a|às|as|pelas|pela|para|on|at|for)\s*|[,;@|–—-]\s*)$/iu;
const RELATIVE = /\b(?:hoje|amanh[aã]|depois de amanh[aã]|pr[oó]xim[oa]s?|est[ae]|daqui|today|tonight|tomorrow|next|this|in \d)/iu;
const DAY_OF_MONTH = /(^|[\s,;])dia\s+(\d{1,2})(?=$|[\s,.;!?])(?!\s+de\s)/giu;
const NUMERIC_DATE = /\d{1,4}\s*[/.-]\s*\d{1,2}/u;
const CLOCK = /(^|[\s,;(])(?:(?:às|as|pelas|at|@)\s*)?(\d{1,2})(?:\s*h\s*(\d{2})?|:(\d{2}))(?=$|[\s,.;)!?])/giu;

function stripAccents(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function normalizedPlaceText(value: string): string {
  return stripAccents(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function chronoReference(now: Date, timezone: string): { instant: Date; timezone?: number } {
  const parts = eventLocalDateTimeParts(now, timezone);
  if (!parts) return { instant: now };
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return { instant: now, timezone: Math.round((asUtc - Math.floor(now.getTime() / 60_000) * 60_000) / 60_000) };
}

function validatedFragment(text: string, options: EventDateTimeParseOptions): Pick<EmbeddedDateTimeFragment, 'date' | 'time'> | undefined {
  const parsed = parseEventDateTimeInput(text, options);
  if (parsed.status === 'missing_time') return { date: parsed.date };
  if (parsed.status === 'ok') {
    const local = eventLocalDateTimeParts(parsed.date, options.timezone);
    if (!local) return undefined;
    return parsed.hadExplicitTime
      ? { date: { year: local.year, month: local.month, day: local.day }, time: { hour: local.hour, minute: local.minute } }
      : { date: { year: local.year, month: local.month, day: local.day } };
  }
  return undefined;
}

/**
 * Finds valid, plausible event dates and clock times inside a free-text answer.
 * Past or out-of-range dates are ignored, so "Avenida 5 de Outubro" stays a name.
 */
export function findEmbeddedDateTime(text: string, options: EventDateTimeParseOptions): EmbeddedDateTime {
  const fragments: EmbeddedDateTimeFragment[] = [];
  const now = options.now ?? new Date();
  const overlaps = (start: number, end: number) => fragments.some(fragment => start < fragment.end && end > fragment.start);
  const parser = chronoParserForLocale(options.locale);
  if (parser) {
    for (const result of parser.parse(text, chronoReference(now, options.timezone), { forwardDate: true })) {
      const start = result.index;
      const end = start + result.text.length;
      const hasDate = result.start.isCertain('day') || result.start.isCertain('weekday') || RELATIVE.test(result.text);
      const hasTime = result.start.isCertain('hour');
      let value: Pick<EmbeddedDateTimeFragment, 'date' | 'time'> | undefined;
      if (hasDate) value = validatedFragment(result.text, { ...options, now });
      else if (hasTime) {
        const hour = result.start.get('hour');
        const minute = result.start.get('minute') ?? 0;
        if (hour !== null && hour !== undefined) value = { time: { hour, minute } };
      }
      if (!value || overlaps(start, end)) continue;
      fragments.push({ start, end, text: result.text, ...value, relative: RELATIVE.test(result.text),
        weekdayOnly: !result.start.isCertain('day') && result.start.isCertain('weekday') && !hasTime && !RELATIVE.test(result.text) });
    }
  }
  // "dia 8": a day of the month without a month name means its next occurrence.
  for (const match of text.matchAll(DAY_OF_MONTH)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const end = (match.index ?? 0) + match[0].length;
    if (overlaps(start, end)) continue;
    const today = eventLocalDateTimeParts(now, options.timezone);
    const day = Number(match[2]);
    if (!today || day < 1 || day > 31) continue;
    for (const monthOffset of [0, 1, 2]) {
      const candidate = new Date(Date.UTC(today.year, today.month - 1 + monthOffset, day, 12));
      if (candidate.getUTCDate() !== day || (monthOffset === 0 && day < today.day)) continue;
      const value = validatedFragment(formatEventDateParts({
        year: candidate.getUTCFullYear(), month: candidate.getUTCMonth() + 1, day
      }), { ...options, now });
      if (value) fragments.push({ start, end, text: match[0].slice(match[1]?.length ?? 0), ...value, relative: false, explicit: true });
      break;
    }
  }
  for (const match of text.matchAll(CLOCK)) {
    const offset = (match.index ?? 0) + (match[1]?.length ?? 0);
    const raw = match[0].slice(match[1]?.length ?? 0);
    const end = offset + raw.length;
    if (overlaps(offset, end)) continue;
    const parsed = parseEventTimeInput(`${match[2]}:${match[3] ?? match[4] ?? '00'}`);
    if (parsed.status !== 'ok') continue;
    fragments.push({ start: offset, end, text: raw, time: parsed.time, relative: false });
  }
  fragments.sort((left, right) => left.start - right.start);
  const strong = fragments.some(fragment => fragment.relative || fragment.explicit || Boolean(fragment.time)
    || NUMERIC_DATE.test(fragment.text)
    || STRONG_BEFORE.test(text.slice(0, fragment.start)));
  // Remove fragments, then the connecting words left next to them.
  let remainder = '';
  let cursor = 0;
  for (const fragment of fragments) {
    remainder += `${text.slice(cursor, fragment.start)}\u0000`;
    cursor = fragment.end;
  }
  remainder += text.slice(cursor);
  for (let changed = true; changed;) {
    const next = remainder
      .replace(CONNECTOR_BEFORE_MARKER, '$1\u0000')
      .replace(/[\s,;:@|()–—-]+\u0000/u, ' \u0000')
      .replace(/\u0000[\s,;:@|()–—-]+/u, '\u0000 ')
      .replace(/\u0000\s*(?:e|and|às|as|pelas|at)\s*\u0000/iu, '\u0000');
    changed = next !== remainder;
    remainder = next;
  }
  remainder = remainder.replace(/\u0000/g, ' ').replace(/\s+/g, ' ').replace(/^[\s,;:@|–—-]+|[\s,;:@|–—-]+$/gu, '').trim();
  const date = fragments.find(fragment => fragment.date)?.date;
  const time = fragments.find(fragment => fragment.time)?.time;
  return { fragments, remainder, strong, whole: fragments.length > 0 && !/[\p{L}\p{N}]/u.test(remainder), date, time };
}

export function formatCarriedDate(date: EventDateParts, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' })
    .format(new Date(Date.UTC(date.year, date.month - 1, date.day, 12)));
}

// ---------------------------------------------------------------------------
// Step wrappers

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface AnswerAheadTarget {
  kind: 'date' | 'time';
  stepId: string;
}

export interface AnswerAheadContext {
  t: Translate;
  locale: string;
  timezoneForState(state: FlowState): string;
  now?: (() => Date) | undefined;
  allowPast?: boolean | undefined;
  /** Later questions that may receive an answer typed too early. */
  targetsForState(state: FlowState): AnswerAheadTarget[];
  stepForId(stepId: string): FlowStep | undefined;
  /** Optional place evidence; returns 'name' when the whole text is a known place name. */
  placeEvidence?: ((input: { text: string; remainder: string; fragments: EmbeddedDateTimeFragment[]; strong: boolean }) =>
    Promise<'name' | 'remainder' | 'unknown'>) | undefined;
}

function promptText(step: FlowStep, state: FlowState): string {
  try { return step.promptForState?.(state) ?? step.prompt; } catch { return step.prompt; }
}

async function resolveWith(step: FlowStep, args: FlowStepInputResolutionInput): Promise<FlowStepInputHandlerResult | undefined> {
  if (step.resolveInputAsync) return step.resolveInputAsync(args);
  return step.resolveInput?.(args);
}

/**
 * Interprets a reply typed at a free-text question that also contains answers
 * for later questions. Returns undefined when the reply is an ordinary answer.
 */
export async function interpretAnswerAhead(
  step: FlowStep,
  args: FlowStepInputResolutionInput,
  context: AnswerAheadContext,
  allowEvidence: boolean
): Promise<FlowStepInputHandlerResult | undefined> {
  const text = args.input.trim();
  const { state } = args;
  const carried = carriedEventAnswers(state.data);
  if (carried?.mode === 'split' && carried.sourceStepId === step.id && carried.proposedValue
    && state.data[step.id] !== carried.proposedValue) {
    const control = eventReplyControl(text);
    if (control === 'accept') return { status: 'use-value', value: carried.proposedValue };
    if (control === 'reject' || normalizedPlaceText(text) === normalizedPlaceText(carried.originalText)) {
      return { status: 'use-value', value: carried.originalText };
    }
  }
  if (!/[\p{L}\p{N}]/u.test(text)) return undefined;
  const timezone = context.timezoneForState(state);
  const now = context.now?.() ?? new Date();
  const found = findEmbeddedDateTime(text, { timezone, locale: context.locale, now, allowPast: context.allowPast });
  if (!found.fragments.length) return undefined;
  const answers: CarriedEventAnswer[] = [];
  for (const target of context.targetsForState(state)) {
    const targetStep = context.stepForId(target.stepId);
    const parts = target.kind === 'date' ? found.date : found.time;
    if (!targetStep || !parts) continue;
    const input = target.kind === 'date'
      ? formatEventDateParts(parts as EventDateParts)
      : formatEventTimeParts(parts as EventTimeParts);
    const resolution = await resolveWith(targetStep, { ...args, step: targetStep, input });
    if (resolution?.status !== 'use-value') continue;
    answers.push({
      stepId: target.stepId,
      input,
      label: target.kind === 'date' ? formatCarriedDate(parts as EventDateParts, context.locale) : input,
      value: resolution.value,
      previous: stepValueJson(state.data, target.stepId)
    });
  }
  if (!answers.length) return undefined;
  const labels = answers.map(answer => answer.label).join(' · ');
  if (found.whole) {
    const record: CarriedEventAnswers = { version: 1, mode: 'suggest', sourceStepId: step.id, originalText: text, answers };
    return {
      status: 'error',
      state: { ...state, data: { ...state.data, [EVENT_CARRIED_ANSWERS_KEY]: record } },
      reply: `${context.t('official.community-events.flow.answerAheadSaved', { answers: labels })}\n\n${promptText(step, state)}`
    };
  }
  if (!found.remainder) return undefined;
  const evidence = allowEvidence && context.placeEvidence
    ? await context.placeEvidence({ text, remainder: found.remainder, fragments: found.fragments, strong: found.strong })
      .catch(() => 'unknown' as const)
    : 'unknown';
  if (evidence === 'name') return undefined;
  if (!found.strong && (evidence !== 'remainder' || found.fragments.every(fragment => fragment.weekdayOnly))) return undefined;
  const record: CarriedEventAnswers = {
    version: 1, mode: 'split', sourceStepId: step.id, originalText: text, proposedValue: found.remainder, answers
  };
  return {
    status: 'error',
    state: { ...state, data: { ...state.data, [EVENT_CARRIED_ANSWERS_KEY]: record } },
    reply: context.t('official.community-events.flow.answerSplitProposal', {
      place: found.remainder, answers: labels, original: text
    })
  };
}

/** Accepts a suggestion carried from an earlier reply with "ok". */
async function acceptCarriedSuggestion(step: FlowStep, args: FlowStepInputResolutionInput, original: FlowStep): Promise<FlowStepInputHandlerResult | undefined> {
  const suggestion = carriedEventSuggestion(args.state.data, step.id);
  if (!suggestion) return undefined;
  return await resolveWith(original, { ...args, input: suggestion.input }) ?? { status: 'use-value', value: suggestion.value };
}

async function emulateKeep(original: FlowStep, args: FlowStepInputResolutionInput): Promise<FlowStepInputHandlerResult | undefined> {
  const savedAnswer = flowSavedAnswer(args.step, args.state);
  if (!savedAnswer) return undefined;
  const keptArgs = { ...args, savedAnswer };
  const resolution = original.resolveKeptInputAsync ? await original.resolveKeptInputAsync(keptArgs)
    : original.resolveKeptInput ? original.resolveKeptInput(keptArgs)
      : typeof savedAnswer.value === 'string' ? await resolveWith(original, { ...args, input: savedAnswer.value }) : undefined;
  if (resolution?.status === 'error') return resolution;
  return { status: 'use-value', value: resolution?.status === 'use-value' ? resolution.value : structuredClone(savedAnswer.value) };
}

function emulateSkip(original: FlowStep, args: FlowStepInputResolutionInput): FlowStepInputHandlerResult | undefined {
  if (!original.navigation?.skip && !original.skipOnSymbolInput) return undefined;
  const resolution = original.resolveSkippedInput?.(args);
  if (resolution?.status === 'error') return resolution;
  return { status: 'use-value', value: resolution?.status === 'use-value' ? resolution.value : null };
}

export interface ResilientStepOptions {
  t: Translate;
  /** Present for free-text questions asked before the event date. */
  answerAhead?: AnswerAheadContext | undefined;
  /** Allows async evidence lookups (geocoding) before proposing a split. */
  asyncEvidence?: boolean | undefined;
}

/**
 * Wraps a text step so plain words work like the slash controls ("Keep",
 * "skip", "ok"), carried suggestions can be accepted, and answers typed for
 * later questions are kept instead of being stored at the wrong question.
 */
export function withResilientReplies(original: FlowStep, options: ResilientStepOptions): FlowStep {
  if (original.kind !== 'text') return original;
  const interpret = async (args: FlowStepInputResolutionInput, allowAsync: boolean): Promise<FlowStepInputHandlerResult | undefined> => {
    const control = eventReplyControl(args.input);
    if (control === 'accept') {
      const accepted = await acceptCarriedSuggestion(args.step, args, original);
      if (accepted) return accepted;
    }
    if (control === 'keep') {
      const kept = await emulateKeep(original, args);
      if (kept) return kept;
    }
    if (control === 'skip') {
      const skipped = emulateSkip(original, args);
      if (skipped) return skipped;
    }
    if (control === 'cancel' || control === 'back') {
      return { status: 'error', reply: options.t(`official.community-events.flow.${control}Hint`) };
    }
    if (options.answerAhead) {
      const ahead = await interpretAnswerAhead(args.step, args, options.answerAhead, allowAsync);
      if (ahead) return ahead;
    }
    return undefined;
  };
  const step: FlowStep = { ...original };
  // The host awaits resolveInputAsync for text replies; the synchronous
  // resolver stays the original validator for keep/skip reuse.
  step.resolveInputAsync = async (args) => await interpret(args, Boolean(options.asyncEvidence))
    ?? await resolveWith(original, args);
  const decorate = (text: string, state: FlowState) => {
    const suggestion = carriedEventSuggestion(state.data, original.id);
    return suggestion ? `${text}\n\n${options.t('official.community-events.flow.carriedSuggestion', { value: suggestion.label })}` : text;
  };
  step.promptForState = (state) => decorate(original.promptForState?.(state) ?? original.prompt, state);
  if (original.promptMessageForState) {
    step.promptMessageForState = async (state) => {
      const message = await original.promptMessageForState!(state);
      return { ...message, text: decorate(message.text, state) };
    };
  }
  return step;
}
