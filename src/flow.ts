import { randomUUID } from 'node:crypto';
import type { FlowDefinition, FlowState, FlowStep } from '../../../adminBot/flows/flowTypes';
import type { FlowSessionSnapshot } from '../../../adminBot/flows/flowEngine';
import type { TranslateFn } from '../../../platform/i18n';
import { EVENT_CHOICE_QUESTION_TYPE, EVENT_DATE_QUESTION_TYPE, EVENT_TIME_QUESTION_TYPE, type EventProfile, type EventQuestion } from './config';
import {
  combineEventDateAndTime,
  eventDateAnswer,
  eventDateAndTimeToUtc,
  eventDateTemplateTokens,
  eventTimeAnswer,
  formatEventDateParts,
  formatEventDateTime,
  formatEventTimeParts,
  isEventDateAnswer,
  isEventTimeAnswer,
  parseEventDateInput,
  parseEventTimeInput
} from './datetime';
import type { EventSpanKind } from './span';
import { eventDurationMinutes, validEventSpanDuration } from './span';

export const EVENT_PROFILE_STEP_ID = 'profile';
export const EVENT_SPAN_STEP_ID_PREFIX = 'span-';
export const EVENT_END_DATE_STEP_ID_PREFIX = 'end-date-';
export const EVENT_END_TIME_STEP_ID_PREFIX = 'end-time-';
const EVENT_CONFIRM_VALUE = 'yes';
const EVENT_PAST_COMPLETION_CONFIRM_VALUE = 'yes-complete';
const DEFAULT_MULTI_DAY_END_TIME = { hour: 23, minute: 59, raw: '23:59' } as const;

export interface EventFlowAnswers {
  profileId: string;
  answers: Record<string, string>;
  startsAt: Date;
  endsAt: Date;
  spanKind: EventSpanKind;
  localDate: string;
  localTime?: string | undefined;
  endLocalDate?: string | undefined;
  endLocalTime?: string | undefined;
}

export interface EventFlowPrefill {
  profileId?: string | undefined;
  answers: Record<string, string>;
  spanKind?: EventSpanKind | undefined;
  endLocalDate?: string | undefined;
  endLocalTime?: string | undefined;
}

export const EVENT_CREATION_FLOW_TYPE_PREFIX = 'official.community-events.create.';

export function createEventFlowDefinition(input: {
  t: TranslateFn;
  profiles: EventProfile[];
  prefill?: EventFlowPrefill | undefined;
  timezone?: string | undefined;
  locale?: string | undefined;
  initialData?: Record<string, unknown> | undefined;
  askPrefilledQuestions?: boolean | undefined;
  flowTypePrefix?: string | undefined;
  flowInstanceId?: string | undefined;
  confirmMessageKey?: string | undefined;
  pastCompletionConfirmMessageKey?: string | undefined;
  completeMessageKey?: string | false | undefined;
  allowPastStartsAt?: boolean | undefined;
  now?: (() => Date) | undefined;
}): FlowDefinition {
  const flowType = input.flowTypePrefix
    ? `${input.flowTypePrefix}.${input.flowInstanceId?.trim() || randomUUID()}`
    : `${EVENT_CREATION_FLOW_TYPE_PREFIX}${randomUUID()}`;
  return buildEventFlowDefinition(input, flowType);
}

export function restoreEventFlowDefinition(input: {
  flowType: string;
  t: TranslateFn;
  profiles: EventProfile[];
  prefill?: EventFlowPrefill | undefined;
  timezone?: string | undefined;
  locale?: string | undefined;
  initialData: Record<string, unknown>;
}): FlowDefinition {
  const flowType = input.flowType.trim();
  if (!isEventCreationFlowType(flowType)) {
    throw new Error(`Invalid event creation flow type: ${flowType || '(empty)'}`);
  }
  return buildEventFlowDefinition({
    t: input.t,
    profiles: input.profiles,
    prefill: input.prefill,
    timezone: input.timezone,
    locale: input.locale,
    initialData: input.initialData,
    completeMessageKey: false
  }, flowType);
}

export function isEventCreationFlowType(flowType: string): boolean {
  return flowType.startsWith(EVENT_CREATION_FLOW_TYPE_PREFIX)
    && flowType.length > EVENT_CREATION_FLOW_TYPE_PREFIX.length;
}

function buildEventFlowDefinition(input: {
  t: TranslateFn;
  profiles: EventProfile[];
  prefill?: EventFlowPrefill | undefined;
  timezone?: string | undefined;
  locale?: string | undefined;
  initialData?: Record<string, unknown> | undefined;
  askPrefilledQuestions?: boolean | undefined;
  confirmMessageKey?: string | undefined;
  pastCompletionConfirmMessageKey?: string | undefined;
  completeMessageKey?: string | false | undefined;
  allowPastStartsAt?: boolean | undefined;
  now?: (() => Date) | undefined;
}, flowType: string): FlowDefinition {
  const timezone = input.timezone ?? 'UTC';
  const locale = input.locale ?? 'en';
  const initialData = input.initialData ?? eventInitialFlowData(input.profiles, input.prefill, {
    timezone,
    locale,
    now: input.now?.(),
    allowPast: input.allowPastStartsAt
  });
  const initialProfileId = typeof initialData[EVENT_PROFILE_STEP_ID] === 'string'
    ? String(initialData[EVENT_PROFILE_STEP_ID])
    : undefined;
  const initialProfile = initialProfileId
    ? input.profiles.find((profile) => profile.id === initialProfileId)
    : undefined;
  const steps: FlowDefinition['steps'] = {
    [EVENT_PROFILE_STEP_ID]: {
      id: EVENT_PROFILE_STEP_ID,
      kind: 'choice',
      prompt: input.t('official.community-events.flow.profile'),
      options: input.profiles.map((profile) => ({ label: profile.label, value: profile.id })),
      minSelections: 1,
      maxSelections: 1,
      nextStepIdByValue: Object.fromEntries(input.profiles.map((profile) => [
        profile.id,
        firstQuestionStepId(profile)
      ]))
    }
  };

  for (const profile of input.profiles) {
    const visibleQuestions = input.askPrefilledQuestions
      ? profile.questions
      : initialProfile?.id === profile.id
      ? profile.questions.filter((question) => !questionComplete(profile, question, initialData))
      : profile.questions;
    for (const [index, question] of visibleQuestions.entries()) {
      const nextQuestion = visibleQuestions[index + 1];
      const stepId = questionStepId(profile, question);
      const nextStepId = nextQuestion
        ? questionStepId(profile, nextQuestion)
        : input.askPrefilledQuestions
          ? spanStepId(profile)
          : firstMissingSpanStepId(profile, initialData) ?? confirmStepId(profile);
      if (question.type === EVENT_CHOICE_QUESTION_TYPE) {
        steps[stepId] = {
          id: stepId,
          kind: 'choice',
          prompt: questionPrompt(input.t, profile, question, input.prefill?.answers[question.key]),
          options: question.choices.map((choice) => ({ label: choice.label, value: choice.id })),
          minSelections: question.required ? 1 : 0,
          maxSelections: 1,
          skipOnSymbolInput: !question.required,
          nextStepId
        };
        continue;
      }
      steps[stepId] = {
        id: stepId,
        kind: 'text',
        prompt: questionPrompt(input.t, profile, question, input.prefill?.answers[question.key]),
        nextStepId,
        skipOnSymbolInput: !question.required,
        ...(question.type === EVENT_DATE_QUESTION_TYPE
          ? {
              resolveInput: (resolutionInput) => resolveDateQuestionInput({
                t: input.t,
                timezone,
                locale,
                now: input.now,
                allowPast: input.allowPastStartsAt,
                input: resolutionInput
              })
            }
          : question.type === EVENT_TIME_QUESTION_TYPE
            ? {
                resolveInput: (resolutionInput) => resolveTimeQuestionInput({
                  t: input.t,
                  timezone,
                  locale,
                  now: input.now,
                  allowPast: input.allowPastStartsAt,
                  profile,
                  input: resolutionInput
                })
              }
            : {})
      };
    }
    steps[spanStepId(profile)] = {
      id: spanStepId(profile),
      kind: 'choice',
      prompt: input.t('official.community-events.flow.spanKind'),
      options: [
        { label: input.t('official.community-events.span.dayTrip'), value: 'day_trip' },
        { label: input.t('official.community-events.span.multiDay'), value: 'multi_day' }
      ],
      minSelections: 1,
      maxSelections: 1,
      nextStepIdByValue: {
        day_trip: confirmStepId(profile),
        multi_day: endDateStepId(profile)
      }
    };
    steps[endDateStepId(profile)] = {
      id: endDateStepId(profile),
      kind: 'text',
      prompt: input.t('official.community-events.flow.endDate'),
      nextStepId: endTimeStepId(profile),
      resolveInput: (resolutionInput) => resolveDateQuestionInput({
        t: input.t,
        timezone,
        locale,
        now: input.now,
        allowPast: input.allowPastStartsAt,
        input: resolutionInput
      })
    };
    steps[endTimeStepId(profile)] = {
      id: endTimeStepId(profile),
      kind: 'text',
      prompt: optionalFlowPrompt(input.t, profile, input.t('official.community-events.flow.endTime')),
      nextStepId: confirmStepId(profile),
      skipOnSymbolInput: true,
      resolveSkippedInput: (resolutionInput) => resolveSkippedEventEndTime({
        t: input.t,
        profile,
        timezone,
        locale,
        input: resolutionInput
      }),
      resolveInput: (resolutionInput) => resolveEventEndTimeInput({
        t: input.t,
        profile,
        timezone,
        locale,
        input: resolutionInput
      })
    };
    steps[confirmStepId(profile)] = {
      id: confirmStepId(profile),
      kind: 'choice',
      prompt: input.t(input.confirmMessageKey ?? 'official.community-events.flow.confirm', { summary: profile.label }),
      promptForState: (state) => {
        const messageKey = input.allowPastStartsAt &&
          eventFlowStartsInPast(state, profile, timezone, locale, input.now?.() ?? new Date())
          ? input.pastCompletionConfirmMessageKey ?? input.confirmMessageKey ?? 'official.community-events.flow.confirm'
          : input.confirmMessageKey ?? 'official.community-events.flow.confirm';
        return input.t(messageKey, {
          summary: eventConfirmationSummary(state, profile, timezone, locale, input.t)
        });
      },
      optionsForState: (state) => [
        {
          label: input.t('official.community-events.flow.yes'),
          value: input.allowPastStartsAt &&
            eventFlowStartsInPast(state, profile, timezone, locale, input.now?.() ?? new Date())
            ? EVENT_PAST_COMPLETION_CONFIRM_VALUE
            : EVENT_CONFIRM_VALUE
        },
        { label: input.t('official.community-events.flow.no'), value: 'no' }
      ],
      options: [
        { label: input.t('official.community-events.flow.yes'), value: EVENT_CONFIRM_VALUE },
        { label: input.t('official.community-events.flow.no'), value: 'no' }
      ],
      minSelections: 1,
      maxSelections: 1
    };
  }

  return {
    flowType,
    t: input.t,
    initialStepId: initialProfile
      ? input.askPrefilledQuestions
        ? firstQuestionStepId(initialProfile)
        : firstMissingQuestionStepId(initialProfile, initialData)
          ?? firstMissingSpanStepId(initialProfile, initialData)
          ?? confirmStepId(initialProfile)
      : EVENT_PROFILE_STEP_ID,
    context: 'either',
    timeoutMinutes: 30,
    completionReply: input.completeMessageKey === false
      ? false
      : input.t(input.completeMessageKey ?? 'official.community-events.flow.complete'),
    steps
  };
}

export function eventInitialFlowData(
  profiles: EventProfile[],
  prefill: EventFlowPrefill | undefined,
  options?: {
    timezone: string;
    locale: string;
    now?: Date | undefined;
    allowPast?: boolean | undefined;
  } | undefined
): Record<string, unknown> {
  const profileId = prefill?.profileId ?? (profiles.length === 1 ? profiles[0]?.id : undefined);
  if (!profileId) {
    return {};
  }
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    return {};
  }
  const data: Record<string, unknown> = {
    [EVENT_PROFILE_STEP_ID]: profile.id
  };
  for (const question of profile.questions) {
    const value = prefill?.answers[question.key]?.trim();
    if (value) {
      data[questionStepId(profile, question)] = initialQuestionValue(question, value, options);
    }
  }
  if (prefill?.spanKind) {
    data[spanStepId(profile)] = [prefill.spanKind];
  }
  if (prefill?.endLocalDate) {
    const parsed = parseEventDateInput(prefill.endLocalDate, {
      timezone: options?.timezone ?? 'UTC',
      locale: options?.locale ?? 'en',
      now: options?.now,
      allowPast: options?.allowPast
    });
    if (parsed.status === 'ok') {
      data[endDateStepId(profile)] = eventDateAnswer(parsed);
    }
  }
  if (prefill?.endLocalTime) {
    const parsed = parseEventTimeInput(prefill.endLocalTime);
    if (parsed.status === 'ok') {
      data[endTimeStepId(profile)] = eventTimeAnswer(parsed);
    }
  }
  return data;
}

export function eventConfirmPurpose(flowType: string, profile: EventProfile): string {
  return `flow.${flowType}.${confirmStepId(profile)}`;
}

export function eventFlowConfirmed(snapshot: FlowSessionSnapshot, profile: EventProfile): boolean {
  const value = snapshot.state.data[confirmStepId(profile)];
  return Array.isArray(value)
    ? value.includes(EVENT_CONFIRM_VALUE) || value.includes(EVENT_PAST_COMPLETION_CONFIRM_VALUE)
    : value === EVENT_CONFIRM_VALUE || value === EVENT_PAST_COMPLETION_CONFIRM_VALUE;
}

export function eventFlowPastCompletionConfirmed(snapshot: FlowSessionSnapshot, profile: EventProfile): boolean {
  const value = snapshot.state.data[confirmStepId(profile)];
  return Array.isArray(value)
    ? value.includes(EVENT_PAST_COMPLETION_CONFIRM_VALUE)
    : value === EVENT_PAST_COMPLETION_CONFIRM_VALUE;
}

export function eventFlowSelectedProfileId(snapshot: FlowSessionSnapshot): string | undefined {
  const value = snapshot.state.data[EVENT_PROFILE_STEP_ID];
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

export function eventFlowAnswers(
  snapshot: FlowSessionSnapshot,
  profile: EventProfile,
  timezone: string,
  locale = 'en'
): EventFlowAnswers | undefined {
  return eventFlowAnswersFromData(snapshot.state.data, profile, timezone, locale);
}

export function eventFlowAnswersFromRaw(input: {
  profile: EventProfile;
  answers: Record<string, string>;
  timezone: string;
  locale: string;
  now?: Date | undefined;
  spanKind?: EventSpanKind | undefined;
  endLocalDate?: string | undefined;
  endLocalTime?: string | undefined;
}): EventFlowAnswers | undefined {
  const data: Record<string, unknown> = {
    [EVENT_PROFILE_STEP_ID]: input.profile.id
  };
  for (const question of input.profile.questions) {
    const value = input.answers[question.key]?.trim() ?? '';
    if (!value) {
      continue;
    }
    if (question.type === EVENT_DATE_QUESTION_TYPE) {
      const parsed = parseEventDateInput(value, {
        timezone: input.timezone,
        locale: input.locale,
        now: input.now
      });
      if (parsed.status !== 'ok') {
        return undefined;
      }
      data[questionStepId(input.profile, question)] = eventDateAnswer(parsed);
      continue;
    }
    if (question.type === EVENT_TIME_QUESTION_TYPE) {
      const parsed = parseEventTimeInput(value);
      if (parsed.status !== 'ok') {
        return undefined;
      }
      data[questionStepId(input.profile, question)] = eventTimeAnswer(parsed);
      continue;
    }
    if (question.type === EVENT_CHOICE_QUESTION_TYPE) {
      const selected = initialChoiceValue(question, value);
      if (!selected) {
        return undefined;
      }
      data[questionStepId(input.profile, question)] = selected;
      continue;
    }
    data[questionStepId(input.profile, question)] = value;
  }
  data[spanStepId(input.profile)] = [input.spanKind ?? 'day_trip'];
  if (input.endLocalDate) {
    const parsed = parseEventDateInput(input.endLocalDate, {
      timezone: input.timezone,
      locale: input.locale,
      now: input.now,
      allowPast: true
    });
    if (parsed.status !== 'ok') return undefined;
    data[endDateStepId(input.profile)] = eventDateAnswer(parsed);
  }
  if (input.endLocalTime) {
    const parsed = parseEventTimeInput(input.endLocalTime);
    if (parsed.status !== 'ok') return undefined;
    data[endTimeStepId(input.profile)] = eventTimeAnswer(parsed);
  } else if ((input.spanKind ?? 'day_trip') === 'multi_day' && input.endLocalDate) {
    data[endTimeStepId(input.profile)] = null;
  }
  return eventFlowAnswersFromData(data, input.profile, input.timezone, input.locale, input.now);
}

export function renderEventTemplate(input: {
  template: string;
  profile: EventProfile;
  answers: Record<string, string>;
  startsAt: Date;
  endsAt?: Date | undefined;
  spanKind?: EventSpanKind | undefined;
  timezone: string;
  locale?: string | undefined;
  creatorDisplayName: string;
  extraTokens?: Record<string, string | undefined> | undefined;
}): string {
  const dateTokens = eventDateTemplateTokens(input.startsAt, input.timezone, input.locale);
  const tokens: Record<string, string> = {
    ...input.answers,
    ...dateTokens,
    profileId: input.profile.id,
    profileLabel: input.profile.label,
    creatorDisplayName: input.creatorDisplayName,
    ...(input.spanKind ? { spanKind: input.spanKind } : {}),
    ...(input.endsAt ? {
      endsAt: formatEventDateTime(input.endsAt, input.timezone, input.locale),
      endDate: new Intl.DateTimeFormat(input.locale, { timeZone: input.timezone, dateStyle: 'medium' }).format(input.endsAt),
      endTime: new Intl.DateTimeFormat(input.locale, { timeZone: input.timezone, timeStyle: 'short' }).format(input.endsAt)
    } : {}),
    ...Object.fromEntries(Object.entries(input.extraTokens ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1])))
  };
  return input.template.replace(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g, (_match, key: string) => tokens[key] ?? '');
}

export function selectedOptionLabels(profile: EventProfile): string[] {
  return profile.poll.options.map((option) => option.label);
}

export function calendarLocation(profile: EventProfile, answers: Record<string, string>): string | undefined {
  return profile.location.source === 'fixed'
    ? profile.location.label
    : answers[profile.location.questionKey];
}

export function calendarDescription(
  profile: EventProfile,
  answers: Record<string, string>,
  startsAt: Date,
  timezone: string,
  locale = 'en',
  endsAt?: Date | undefined,
  spanKind?: EventSpanKind | undefined
): string | undefined {
  const template = profile.calendar.descriptionTemplate;
  return template
    ? renderEventTemplate({
        template,
        profile,
        answers,
        startsAt,
        ...(endsAt ? { endsAt } : {}),
        ...(spanKind ? { spanKind } : {}),
        timezone,
        locale,
        creatorDisplayName: ''
      }).trim()
    : undefined;
}

function eventFlowAnswersFromData(
  data: Record<string, unknown>,
  profile: EventProfile,
  timezone: string,
  locale = 'en',
  now?: Date | undefined
): EventFlowAnswers | undefined {
  const answers: Record<string, string> = {};
  let startDate: ReturnType<typeof eventDatePartsFromRaw>;
  let startTime: ReturnType<typeof eventTimePartsFromRaw>;
  for (const question of profile.questions) {
    const raw = data[questionStepId(profile, question)];
    const value = eventAnswerValue(raw, question);
    if (question.required && !value) {
      return undefined;
    }
    if (value) {
      answers[question.key] = value;
    }
    if (question.key === profile.startsAtDateQuestionKey) {
      startDate = eventDatePartsFromRaw(raw);
    }
    if (question.key === profile.startsAtTimeQuestionKey) {
      startTime = eventTimePartsFromRaw(raw);
    }
  }
  if (!startDate) {
    return undefined;
  }
  const explicitStartTime = startTime;
  const materializedStartTime = explicitStartTime ?? { hour: 0, minute: 0, raw: '00:00' };
  const startsAt = materializeEventStart(startDate, materializedStartTime, { timezone, locale, now });
  if (!startsAt) {
    return undefined;
  }
  const rawSpanKind = data[spanStepId(profile)];
  const selectedSpanKind = Array.isArray(rawSpanKind) ? rawSpanKind[0] : rawSpanKind;
  if (selectedSpanKind !== 'day_trip' && selectedSpanKind !== 'multi_day') {
    return undefined;
  }
  let endsAt: Date;
  let endLocalDate: string | undefined;
  let endLocalTime: string | undefined;
  if (selectedSpanKind === 'day_trip') {
    endsAt = new Date(startsAt.getTime() + profile.calendar.durationMinutes * 60_000);
  } else {
    const endDate = eventDatePartsFromRaw(data[endDateStepId(profile)]);
    const rawEndTime = data[endTimeStepId(profile)];
    const endTime = eventTimePartsFromRaw(rawEndTime)
      ?? (rawEndTime === null ? DEFAULT_MULTI_DAY_END_TIME : undefined);
    if (!endDate || !endTime) {
      return undefined;
    }
    const materializedEnd = eventDateAndTimeToUtc(endDate, endTime, timezone);
    const durationMinutes = materializedEnd
      ? eventDurationMinutes(startsAt, materializedEnd)
      : 0;
    if (
      !materializedEnd
      || !validEventSpanDuration('multi_day', durationMinutes)
    ) {
      return undefined;
    }
    endsAt = materializedEnd;
    endLocalDate = formatEventDateParts(endDate);
    endLocalTime = formatEventTimeParts(endTime);
  }
  return {
    profileId: profile.id,
    answers,
    startsAt,
    endsAt,
    spanKind: selectedSpanKind,
    localDate: formatEventDateParts(startDate),
    ...(explicitStartTime ? { localTime: formatEventTimeParts(explicitStartTime) } : {}),
    ...(endLocalDate ? { endLocalDate } : {}),
    ...(endLocalTime ? { endLocalTime } : {})
  };
}

function firstQuestionStepId(profile: EventProfile): string {
  return questionStepId(profile, profile.questions[0]!);
}

function firstMissingQuestionStepId(profile: EventProfile, data: Record<string, unknown>): string | undefined {
  const question = profile.questions.find((candidate) => !questionComplete(profile, candidate, data));
  return question ? questionStepId(profile, question) : undefined;
}

function firstMissingSpanStepId(profile: EventProfile, data: Record<string, unknown>): string | undefined {
  const rawSpanKind = data[spanStepId(profile)];
  const spanKind = Array.isArray(rawSpanKind) ? rawSpanKind[0] : rawSpanKind;
  if (spanKind !== 'day_trip' && spanKind !== 'multi_day') {
    return spanStepId(profile);
  }
  if (spanKind === 'multi_day') {
    if (!isEventDateAnswer(data[endDateStepId(profile)])) return endDateStepId(profile);
    const endTime = data[endTimeStepId(profile)];
    if (endTime !== null && !isEventTimeAnswer(endTime)) return endTimeStepId(profile);
  }
  return undefined;
}

function questionStepId(profile: EventProfile, question: EventQuestion): string {
  return `q-${profile.id}-${question.key}`;
}

function confirmStepId(profile: EventProfile): string {
  return `confirm-${profile.id}`;
}

function spanStepId(profile: EventProfile): string {
  return `${EVENT_SPAN_STEP_ID_PREFIX}${profile.id}`;
}

function endDateStepId(profile: EventProfile): string {
  return `${EVENT_END_DATE_STEP_ID_PREFIX}${profile.id}`;
}

function endTimeStepId(profile: EventProfile): string {
  return `${EVENT_END_TIME_STEP_ID_PREFIX}${profile.id}`;
}

function questionPrompt(t: TranslateFn, profile: EventProfile, question: EventQuestion, currentValue?: string | undefined): string {
  const optionalSuffix = optionalQuestionPromptSuffix(t, profile, question);
  const basePrompt = questionPromptByType(t, question);
  const prompt = currentValue?.trim()
    ? t('official.community-events.flow.currentValuePrompt', { prompt: basePrompt, current: currentValue.trim() })
    : basePrompt;
  return optionalSuffix ? `${prompt}\n${optionalSuffix}` : prompt;
}

function questionPromptByType(t: TranslateFn, question: EventQuestion): string {
  if (question.type === EVENT_DATE_QUESTION_TYPE) {
    return t('official.community-events.flow.datePrompt', { prompt: question.prompt });
  }
  if (question.type === EVENT_TIME_QUESTION_TYPE) {
    return t('official.community-events.flow.timePrompt', { prompt: question.prompt });
  }
  return question.prompt;
}

function optionalQuestionPromptSuffix(t: TranslateFn, profile: EventProfile, question: EventQuestion): string {
  if (question.required) {
    return '';
  }
  return profileOptionalPromptSuffix(t, profile);
}

function optionalFlowPrompt(t: TranslateFn, profile: EventProfile, prompt: string): string {
  const suffix = profileOptionalPromptSuffix(t, profile);
  return suffix ? `${prompt}\n${suffix}` : prompt;
}

function profileOptionalPromptSuffix(t: TranslateFn, profile: EventProfile): string {
  return profile.optionalPromptSuffix.trim()
    ? profile.optionalPromptSuffix
    : t('official.community-events.flow.optionalPromptSuffix');
}

function resolveDateQuestionInput(input: {
  t: TranslateFn;
  timezone: string;
  locale: string;
  now?: (() => Date) | undefined;
  allowPast?: boolean | undefined;
  input: {
    definition: FlowDefinition;
    state: FlowState;
    step: FlowStep;
    input: string;
  };
}): ReturnType<NonNullable<FlowStep['resolveInput']>> {
  const options = {
    timezone: input.timezone,
    locale: input.locale,
    now: input.now?.(),
    allowPast: input.allowPast
  };
  const parsed = parseEventDateInput(input.input.input, options);
  if (parsed.status === 'ok') {
    return {
      status: 'use-value',
      value: eventDateAnswer(parsed)
    };
  }
  return {
    status: 'error',
    reply: dateErrorMessage(input.t, parsed.reason)
  };
}

function resolveTimeQuestionInput(input: {
  t: TranslateFn;
  timezone: string;
  locale: string;
  now?: (() => Date) | undefined;
  allowPast?: boolean | undefined;
  profile: EventProfile;
  input: {
    definition: FlowDefinition;
    state: FlowState;
    step: FlowStep;
    input: string;
  };
}): ReturnType<NonNullable<FlowStep['resolveInput']>> {
  const result = parseEventTimeInput(input.input.input);
  if (result.status === 'ok') {
    const value = eventTimeAnswer(result);
    const dateRaw = input.input.state.data[questionStepId(input.profile, startDateQuestion(input.profile))];
    const date = eventDatePartsFromRaw(dateRaw);
    if (date) {
      const combined = combineEventDateAndTime(date, value, {
        timezone: input.timezone,
        locale: input.locale,
        now: input.now?.(),
        allowPast: input.allowPast
      });
      if (combined.status === 'invalid') {
        return { status: 'error', reply: dateTimeErrorMessage(input.t, combined.reason) };
      }
    }
    return {
      status: 'use-value',
      value
    };
  }
  return {
    status: 'error',
    reply: input.t('official.community-events.flow.timeInvalid')
  };
}

function resolveEventEndTimeInput(input: {
  t: TranslateFn;
  profile: EventProfile;
  timezone: string;
  locale: string;
  input: {
    definition: FlowDefinition;
    state: FlowState;
    step: FlowStep;
    input: string;
  };
}): ReturnType<NonNullable<FlowStep['resolveInput']>> {
  const parsed = parseEventTimeInput(input.input.input);
  if (parsed.status !== 'ok') {
    return { status: 'error', reply: input.t('official.community-events.flow.timeInvalid') };
  }
  const candidateData = {
    ...input.input.state.data,
    [endTimeStepId(input.profile)]: eventTimeAnswer(parsed)
  };
  const answers = eventFlowAnswersFromData(candidateData, input.profile, input.timezone, input.locale);
  if (!answers) {
    return { status: 'error', reply: input.t('official.community-events.flow.endInvalid') };
  }
  return { status: 'use-value', value: eventTimeAnswer(parsed) };
}

function resolveSkippedEventEndTime(input: {
  t: TranslateFn;
  profile: EventProfile;
  timezone: string;
  locale: string;
  input: {
    definition: FlowDefinition;
    state: FlowState;
    step: FlowStep;
    input: string;
  };
}): ReturnType<NonNullable<FlowStep['resolveSkippedInput']>> {
  const candidateData = {
    ...input.input.state.data,
    [endTimeStepId(input.profile)]: null
  };
  const answers = eventFlowAnswersFromData(candidateData, input.profile, input.timezone, input.locale);
  if (!answers) {
    return { status: 'error', reply: input.t('official.community-events.flow.endInvalid') };
  }
  return { status: 'use-value', value: null };
}

function initialQuestionValue(
  question: EventQuestion,
  value: string,
  options: { timezone: string; locale: string; now?: Date | undefined; allowPast?: boolean | undefined } | undefined
): unknown {
  if (question.type === EVENT_DATE_QUESTION_TYPE && options) {
    const result = parseEventDateInput(value, options);
    return result.status === 'ok' ? eventDateAnswer(result) : undefined;
  }
  if (question.type === EVENT_TIME_QUESTION_TYPE) {
    const result = parseEventTimeInput(value);
    return result.status === 'ok' ? eventTimeAnswer(result) : undefined;
  }
  if (question.type === EVENT_CHOICE_QUESTION_TYPE) {
    return initialChoiceValue(question, value);
  }
  return value;
}

function questionComplete(profile: EventProfile, question: EventQuestion, data: Record<string, unknown>): boolean {
  const raw = data[questionStepId(profile, question)];
  if (!question.required && Object.hasOwn(data, questionStepId(profile, question)) && (raw === null || raw === undefined)) {
    return true;
  }
  if (question.type === EVENT_DATE_QUESTION_TYPE) {
    return isEventDateAnswer(raw);
  }
  if (question.type === EVENT_TIME_QUESTION_TYPE) {
    return isEventTimeAnswer(raw);
  }
  if (question.type === EVENT_CHOICE_QUESTION_TYPE) {
    if (!question.required && Array.isArray(raw) && raw.length === 0) {
      return true;
    }
    return Array.isArray(raw) && raw.some((value) => typeof value === 'string' && value.trim().length > 0);
  }
  return typeof raw === 'string' && raw.trim().length > 0;
}

function eventAnswerValue(raw: unknown, question: EventQuestion): string {
  if (question.type === EVENT_DATE_QUESTION_TYPE) {
    return isEventDateAnswer(raw) ? raw.normalized : '';
  }
  if (question.type === EVENT_TIME_QUESTION_TYPE) {
    return isEventTimeAnswer(raw) ? raw.normalized : '';
  }
  if (question.type === EVENT_CHOICE_QUESTION_TYPE) {
    const selected = Array.isArray(raw) ? raw[0] : raw;
    if (typeof selected !== 'string') {
      return '';
    }
    const choice = question.choices.find((candidate) => candidate.id === selected || candidate.label === selected);
    return choice?.label ?? selected.trim();
  }
  return typeof raw === 'string' ? raw.trim() : '';
}

function startDateQuestion(profile: EventProfile): EventQuestion {
  const question = profile.questions.find((candidate) => candidate.key === profile.startsAtDateQuestionKey);
  return question ?? profile.questions[0]!;
}

function eventDatePartsFromRaw(raw: unknown): ({ year: number; month: number; day: number; raw?: string | undefined }) | undefined {
  return isEventDateAnswer(raw)
    ? { year: raw.year, month: raw.month, day: raw.day, raw: raw.raw }
    : undefined;
}

function eventTimePartsFromRaw(raw: unknown): ({ hour: number; minute: number; raw?: string | undefined }) | undefined {
  return isEventTimeAnswer(raw)
    ? { hour: raw.hour, minute: raw.minute, raw: raw.raw }
    : undefined;
}

function materializeEventStart(
  date: { year: number; month: number; day: number; raw?: string | undefined },
  time: { hour: number; minute: number; raw?: string | undefined },
  options: { timezone: string; locale: string; now?: Date | undefined; allowPast?: boolean | undefined }
): Date | undefined {
  if (!options.now) {
    return eventDateAndTimeToUtc(date, time, options.timezone);
  }
  const parsed = combineEventDateAndTime(date, time, options);
  return parsed.status === 'ok' ? parsed.date : undefined;
}

function eventFlowStartsInPast(
  state: FlowState,
  profile: EventProfile,
  timezone: string,
  locale: string,
  now: Date
): boolean {
  const answers = eventFlowAnswersFromData(state.data, profile, timezone, locale);
  return Boolean(answers && answers.endsAt.getTime() <= now.getTime());
}

function initialChoiceValue(question: EventQuestion, value: string): unknown {
  const choice = question.choices.find((candidate) =>
    candidate.id.toLowerCase() === value.toLowerCase() ||
    candidate.label.toLowerCase() === value.toLowerCase()
  );
  return choice ? [choice.id] : undefined;
}

function eventConfirmationSummary(state: FlowState, profile: EventProfile, timezone: string, locale: string, t: TranslateFn): string {
  const answers = eventFlowAnswersFromData(state.data, profile, timezone, locale);
  if (!answers) {
    return profile.label;
  }
  return t('official.community-events.flow.confirmSummary', {
    profile: profile.label,
    startsAt: formatEventDateTime(answers.startsAt, timezone, locale),
    endsAt: formatEventDateTime(answers.endsAt, timezone, locale),
    span: t(answers.spanKind === 'day_trip'
      ? 'official.community-events.span.dayTrip'
      : 'official.community-events.span.multiDay')
  });
}

function dateErrorMessage(t: TranslateFn, reason: string): string {
  if (reason === 'has_time') {
    return t('official.community-events.flow.dateHasTime');
  }
  if (reason === 'past') {
    return t('official.community-events.flow.datetimePast');
  }
  if (reason === 'too_far') {
    return t('official.community-events.flow.datetimeTooFar');
  }
  if (reason === 'unsupported_locale') {
    return t('official.community-events.flow.dateUnsupportedLocale');
  }
  return t('official.community-events.flow.dateInvalid');
}

function dateTimeErrorMessage(t: TranslateFn, reason: string): string {
  if (reason === 'past') {
    return t('official.community-events.flow.datetimePast');
  }
  if (reason === 'too_far') {
    return t('official.community-events.flow.datetimeTooFar');
  }
  if (reason === 'unsupported_locale') {
    return t('official.community-events.flow.datetimeUnsupportedLocale');
  }
  return t('official.community-events.flow.datetimeInvalid');
}
