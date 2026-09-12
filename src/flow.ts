import { canonicalTimezone } from '../../../../packages/plugin-sdk/src/clock';
import { randomUUID } from 'node:crypto';
import type { FlowDefinition, FlowOption, FlowState, FlowStep } from '../../../../packages/plugin-sdk/src/flow-types';
import type { FlowSessionSnapshot } from './runtime';
import type { TranslateFn } from './runtime';
import {
  EVENT_CHOICE_QUESTION_TYPE,
  EVENT_DATE_QUESTION_TYPE,
  EVENT_TIME_QUESTION_TYPE,
  type EventProfile,
  type EventQuestion,
  type EventQuestionChoice
} from './config';
import {
  combineEventDateAndTime,
  eventDateAnswer,
  eventDateAndTimeToUtc,
  eventLifecycleCompleteAt,
  eventTimeAnswer,
  formatEventDateParts,
  formatEventDateTime,
  formatEventTimeParts,
  isEventDateAnswer,
  isEventTimeAnswer,
  parseEventDateInput,
  parseEventTimeInput,
  type EventDateReference
} from './datetime';
import { eventSpanTemplateValues, formatEventTemplateDate } from './templateDates';
import type { EventSpanKind } from './span';
import { eventDurationMinutes, validEventSpanDuration } from './span';
import {
  EventConditionalTextConfigurationError,
  renderEventConditionalText,
  renderEventTemplateText
} from './template';

export const EVENT_PROFILE_STEP_ID = 'profile';
export const EVENT_CREATION_SPAN_STEP_ID = 'event-span';
export const EVENT_CREATION_POLL_PHASE_STEP_ID = 'event-poll-phase';
export const EVENT_SPAN_STEP_ID_PREFIX = 'span-';
export const EVENT_POLL_PHASE_STEP_ID_PREFIX = 'poll-phase-';
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
  pollPhase?: 'poll' | 'unplanned' | undefined;
  localDate: string;
  localTime?: string | undefined;
  endLocalDate?: string | undefined;
  endLocalTime?: string | undefined;
  startDateReference?: (EventDateReference & { answerKey: string }) | undefined;
  endDateReference?: EventDateReference | undefined;
}

export interface EventFlowPrefill {
  profileId?: string | undefined;
  answers: Record<string, string>;
  spanKind?: EventSpanKind | undefined;
  pollPhase?: 'poll' | 'unplanned' | undefined;
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
  const askPollPhase = isEventCreationFlowType(flowType);
  const creationStepId = (data: Record<string, unknown>) => firstCreationStepId(input.profiles, data);
  const durationFirst = askPollPhase || input.askPrefilledQuestions === true;
  const nextQuestionStepId = (state: FlowState) => input.askPrefilledQuestions
    ? nextReviewQuestionStepId(input.profiles, state)
    : creationStepId(state.data);
  const timezone = canonicalTimezone(input.timezone ?? 'UTC');
  const timezoneForData = (data: Record<string, unknown>) => {
    const selected = input.profiles.find((profile) => profile.id === singleChoiceValue(data[EVENT_PROFILE_STEP_ID]));
    return canonicalTimezone(askPollPhase && selected?.location.source === 'fixed' ? selected.location.timezone : timezone);
  };
  const timezoneForState = (state: FlowState) => timezoneForData(state.data);
  const locale = input.locale ?? 'en';
  const initialData = input.initialData ?? eventInitialFlowData(input.profiles, input.prefill, {
    timezone,
    locale,
    now: input.now?.(),
    allowPast: input.allowPastStartsAt
  });
  const initialProfileId = singleChoiceValue(initialData[EVENT_PROFILE_STEP_ID]);
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
      ...(durationFirst ? {
        nextStepIdForState: nextQuestionStepId
      } : {}),
      nextStepIdByValue: Object.fromEntries(input.profiles.map((profile) => [
        profile.id,
        firstQuestionStepId(profile)
      ]))
    }
  };

  if (durationFirst) {
    steps[EVENT_CREATION_SPAN_STEP_ID] = {
      id: EVENT_CREATION_SPAN_STEP_ID,
      kind: 'choice',
      prompt: input.t('official.community-events.flow.spanKind'),
      options: [
        { label: input.t('official.community-events.span.dayTrip'), value: 'day_trip' },
        { label: input.t('official.community-events.span.multiDay'), value: 'multi_day' }
      ],
      minSelections: 1,
      maxSelections: 1,
      nextStepIdForState: nextQuestionStepId
    };
  }
  if (askPollPhase) {
    steps[EVENT_CREATION_POLL_PHASE_STEP_ID] = {
      id: EVENT_CREATION_POLL_PHASE_STEP_ID,
      kind: 'choice',
      prompt: input.t('official.community-events.flow.pollPhase'),
      options: [
        { label: input.t('official.community-events.flow.pollPhase.poll'), value: 'poll' },
        { label: input.t('official.community-events.flow.pollPhase.unplanned'), value: 'unplanned' }
      ],
      minSelections: 1,
      maxSelections: 1,
      nextStepIdForState: (state) => creationStepId(state.data)
    };
  }

  for (const profile of input.profiles) {
    const visibleQuestions = askPollPhase || input.askPrefilledQuestions
      ? profile.questions
      : initialProfile?.id === profile.id
      ? profile.questions.filter((question) => !questionComplete(profile, question, initialData))
      : profile.questions;
    for (const [index, question] of visibleQuestions.entries()) {
      const nextQuestion = visibleQuestions[index + 1];
      const stepId = questionStepId(profile, question);
      const currentValue = input.askPrefilledQuestions ? undefined : input.prefill?.answers[question.key];
      const nextStepId = nextQuestion
        ? questionStepId(profile, nextQuestion)
        : input.askPrefilledQuestions
          ? spanStepId(profile)
          : firstMissingSpanStepId(profile, initialData, askPollPhase) ?? confirmStepId(profile);
      if (question.type === EVENT_CHOICE_QUESTION_TYPE) {
        const initialOptions = initialEventQuestionChoiceOptions(profile, question, initialData);
        steps[stepId] = {
          id: stepId,
          kind: 'choice',
          prompt: initialQuestionPrompt(input.t, profile, question, initialData, currentValue),
          promptForState: (state) => safeQuestionPromptForState(
            input.t,
            profile,
            question,
            state.data,
            currentValue
          ),
          options: initialOptions,
          optionsForState: (state) => safeEventQuestionChoiceOptions(profile, question, state.data),
          minSelections: question.required ? 1 : 0,
          maxSelections: 1,
          skipOnSymbolInput: !question.required,
          nextStepId,
          ...(durationFirst ? {
            nextStepIdForState: nextQuestionStepId
          } : {})
        };
        continue;
      }
      steps[stepId] = {
        id: stepId,
        kind: 'text',
        prompt: initialQuestionPrompt(input.t, profile, question, initialData, currentValue),
        promptForState: (state) => safeQuestionPromptForState(
          input.t,
          profile,
          question,
          state.data,
          currentValue
        ),
        nextStepId,
        ...(durationFirst ? {
          nextStepIdForState: nextQuestionStepId
        } : {}),
        skipOnSymbolInput: !question.required,
        ...(question.type === EVENT_DATE_QUESTION_TYPE
          ? {
              resolveInput: (resolutionInput) => resolveDateQuestionInput({
                t: input.t,
                timezone: timezoneForState(resolutionInput.state),
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
                  timezone: timezoneForState(resolutionInput.state),
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
        multi_day: askPollPhase ? pollPhaseStepId(profile) : endDateStepId(profile)
      },
      ...(askPollPhase ? {
        nextStepIdForState: (state: FlowState) => creationStepId(state.data)
      } : {})
    };
    if (askPollPhase) {
      steps[pollPhaseStepId(profile)] = {
        id: pollPhaseStepId(profile),
        kind: 'choice',
        prompt: input.t('official.community-events.flow.pollPhase'),
        options: [
          { label: input.t('official.community-events.flow.pollPhase.poll'), value: 'poll' },
          { label: input.t('official.community-events.flow.pollPhase.unplanned'), value: 'unplanned' }
        ],
        minSelections: 1,
        maxSelections: 1,
        nextStepId: endDateStepId(profile),
        nextStepIdForState: (state) => creationStepId(state.data)
      };
    }
    steps[endDateStepId(profile)] = {
      id: endDateStepId(profile),
      kind: 'text',
      prompt: input.t('official.community-events.flow.endDate'),
      nextStepId: endTimeStepId(profile),
      resolveInput: (resolutionInput) => resolveDateQuestionInput({
        t: input.t,
        timezone: timezoneForState(resolutionInput.state),
        locale,
        now: input.now,
        allowPast: input.allowPastStartsAt,
        input: resolutionInput
      })
    };
    steps[endTimeStepId(profile)] = {
      id: endTimeStepId(profile),
      kind: 'text',
      prompt: optionalFlowPrompt(input.t, profile, input.t('official.community-events.flow.endTime'), initialData),
      promptForState: (state) => optionalFlowPrompt(
        input.t,
        profile,
        input.t('official.community-events.flow.endTime'),
        state.data
      ),
      nextStepId: confirmStepId(profile),
      skipOnSymbolInput: true,
      resolveSkippedInput: (resolutionInput) => resolveSkippedEventEndTime({
        t: input.t,
        profile,
        timezone: timezoneForState(resolutionInput.state),
        locale,
        input: resolutionInput
      }),
      resolveInput: (resolutionInput) => resolveEventEndTimeInput({
        t: input.t,
        profile,
        timezone: timezoneForState(resolutionInput.state),
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
          eventFlowStartsInPast(state, profile, timezoneForState(state), locale, input.now?.() ?? new Date())
          ? input.pastCompletionConfirmMessageKey ?? input.confirmMessageKey ?? 'official.community-events.flow.confirm'
          : input.confirmMessageKey ?? 'official.community-events.flow.confirm';
        return input.t(messageKey, {
          summary: eventConfirmationSummary(state, profile, timezoneForState(state), locale, input.t)
        });
      },
      optionsForState: (state) => [
        {
          label: input.t('official.community-events.flow.yes'),
          value: input.allowPastStartsAt &&
            eventFlowStartsInPast(state, profile, timezoneForState(state), locale, input.now?.() ?? new Date())
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

  if (input.askPrefilledQuestions && initialProfile) {
    for (const step of Object.values(steps)) {
      if (step.kind === 'choice') step.backOptionPosition = 'last';
    }
    const keepAnswer = (stepId: string, value: unknown, label?: string, optional = false) => {
      steps[stepId] = withSavedEventAnswer(steps[stepId]!, input.t, value, label, optional);
    };
    keepAnswer(EVENT_PROFILE_STEP_ID, initialProfile.id, initialProfile.label);
    const savedSpan = eventSpanKind(initialData, initialProfile) ?? input.prefill?.spanKind;
    keepAnswer(EVENT_CREATION_SPAN_STEP_ID, savedSpan);
    keepAnswer(spanStepId(initialProfile), savedSpan);
    for (const question of initialProfile.questions) {
      const stepId = questionStepId(initialProfile, question);
      keepAnswer(stepId, initialData[stepId], input.prefill?.answers[question.key], !question.required);
    }
    keepAnswer(endDateStepId(initialProfile), initialData[endDateStepId(initialProfile)], input.prefill?.endLocalDate);
    keepAnswer(endTimeStepId(initialProfile), initialData[endTimeStepId(initialProfile)], input.prefill?.endLocalTime, true);
  }

  return {
    flowType,
    t: input.t,
    initialStepId: input.askPrefilledQuestions ? EVENT_CREATION_SPAN_STEP_ID
      : askPollPhase ? creationStepId(initialData) : initialProfile
        ? firstMissingQuestionStepId(initialProfile, initialData)
          ?? firstMissingSpanStepId(initialProfile, initialData, askPollPhase)
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

function withSavedEventAnswer(
  step: FlowStep,
  t: TranslateFn,
  savedValue: unknown,
  savedLabel?: string,
  optional = false
): FlowStep {
  // Capture the persisted answer, not a replacement entered earlier in this edit.
  // Normalize dates so keeping "tomorrow" cannot move an already scheduled event.
  const value = ((isEventDateAnswer(savedValue) || isEventTimeAnswer(savedValue)
    ? savedValue.normalized
    : singleChoiceValue(savedValue)) ?? savedLabel)?.trim() || undefined;
  if (!value && !optional) return step;
  const current = step.options?.find((option) => option.value === value)?.label
    ?? value ?? t('official.community-events.flow.unset');
  const promptKey = step.kind === 'choice'
    ? 'official.community-events.flow.editChoicePrompt'
    : 'official.community-events.flow.editTextPrompt';
  const prompt = (base: string) => t(promptKey, { prompt: base, current });
  const shared = {
    ...step,
    prompt: prompt(step.prompt),
    promptForState: (state: FlowState) => prompt(step.promptForState?.(state) ?? step.prompt)
  };
  if (step.kind === 'choice') {
    const options = (choices: FlowOption[]): FlowOption[] => {
      const existing = choices.some((choice) => choice.value === value);
      const configured = choices.map((choice) => choice.value === value
        ? { ...choice, replyAliases: [...(choice.replyAliases ?? []), '='] }
        : choice);
      if (!existing) configured.push({ label: current, value: value ?? null, replyAliases: ['='] });
      if (optional) {
        const unset = configured.find((choice) => choice.value === null);
        if (unset) unset.replyAliases = [...(unset.replyAliases ?? []), '-'];
        else configured.push({ label: t('official.community-events.flow.unset'), value: null, replyAliases: ['-'] });
      }
      return configured;
    };
    return {
      ...shared,
      minSelections: 1,
      options: options(step.options ?? []),
      optionsForState: (state) => options(step.optionsForState?.(state) ?? step.options ?? [])
    };
  }
  const keepSavedValue: NonNullable<FlowStep['resolveInput']> = (input) => {
    if (!value) {
      return step.resolveSkippedInput?.(input) ?? { status: 'use-value', value: null };
    }
    // Reuse the original validators, including end-time validation against edited dates.
    return step.resolveInput?.({ ...input, input: value }) ?? { status: 'use-value', value };
  };
  return {
    ...shared,
    resolveInput: (input) => input.input === '=' ? keepSavedValue(input) : step.resolveInput?.(input),
    resolveSkippedInput: (input) => input.input === '=' ? keepSavedValue(input) : step.resolveSkippedInput?.(input)
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
      data[questionStepId(profile, question)] = initialQuestionValue(profile, question, value, data, options);
    }
  }
  if (prefill?.spanKind) {
    data[spanStepId(profile)] = [prefill.spanKind];
  }
  if (prefill?.pollPhase) {
    data[pollPhaseStepId(profile)] = [prefill.pollPhase];
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
  return eventFlowAnswersFromData(snapshot.state.data, profile, isEventCreationFlowType(snapshot.flowType ?? '') && profile.location.source === 'fixed' ? profile.location.timezone : timezone, locale);
}

export function eventFlowAnswersFromRaw(input: {
  allowPast?: boolean | undefined;
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
        now: input.now,
        allowPast: input.allowPast
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
      const selected = initialChoiceValue(
        input.profile,
        question,
        value,
        eventQuestionAnswersBefore(input.profile, data, input.profile.questions.indexOf(question))
      );
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
  return renderEventTemplateText(input.template, eventTemplateValues(input));
}

export function eventTemplateValues(input: {
  profile: EventProfile;
  answers: Record<string, string>;
  startsAt: Date;
  endsAt?: Date | undefined;
  spanKind?: EventSpanKind | undefined;
  timezone: string;
  locale?: string | undefined;
  creatorDisplayName: string;
  extraTokens?: Record<string, string | undefined> | undefined;
}): Record<string, string> {
  return {
    ...input.answers,
    ...(input.answers[input.profile.startsAtDateQuestionKey] ? {
      [input.profile.startsAtDateQuestionKey]: formatEventTemplateDate(input.startsAt, input.timezone, input.locale)
    } : {}),
    ...eventSpanTemplateValues(input),
    profileId: input.profile.id,
    profileLabel: input.profile.label,
    creatorDisplayName: input.creatorDisplayName,
    ...Object.fromEntries(Object.entries(input.extraTokens ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1])))
  };
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
  const selectedSpanKind = eventSpanKind(data, profile);
  if (!selectedSpanKind) return undefined;
  const answers: Record<string, string> = {};
  let startDate: ReturnType<typeof eventDatePartsFromRaw>;
  let startTime: ReturnType<typeof eventTimePartsFromRaw>;
  let startDateReference: EventDateReference | undefined;
  for (const question of profile.questions) {
    const raw = data[questionStepId(profile, question)];
    if (selectedSpanKind === 'multi_day' && question.key === profile.startsAtTimeQuestionKey
      && (data[EVENT_CREATION_SPAN_STEP_ID] || !raw)) continue;
    const value = eventAnswerValue(raw, question, profile, answers);
    if (question.required && !value) {
      return undefined;
    }
    if (value) {
      answers[question.key] = value;
    }
    if (question.key === profile.startsAtDateQuestionKey) {
      startDate = eventDatePartsFromRaw(raw);
      startDateReference = isEventDateAnswer(raw) ? raw.reference : undefined;
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
  let endsAt: Date;
  let endLocalDate: string | undefined;
  let endLocalTime: string | undefined;
  let endDateReference: EventDateReference | undefined;
  if (selectedSpanKind === 'day_trip') {
    endsAt = new Date(startsAt.getTime() + profile.calendar.durationMinutes * 60_000);
  } else {
    const rawEndDate = data[endDateStepId(profile)];
    const endDate = eventDatePartsFromRaw(rawEndDate);
    endDateReference = isEventDateAnswer(rawEndDate) ? rawEndDate.reference : undefined;
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
    pollPhase: eventPollPhase(data, profile) === 'unplanned'
      ? 'unplanned'
      : 'poll',
    localDate: formatEventDateParts(startDate),
    ...(startDateReference ? { startDateReference: { ...startDateReference, answerKey: profile.startsAtDateQuestionKey } } : {}),
    ...(endDateReference ? { endDateReference } : {}),
    ...(explicitStartTime ? { localTime: formatEventTimeParts(explicitStartTime) } : {}),
    ...(endLocalDate ? { endLocalDate } : {}),
    ...(endLocalTime ? { endLocalTime } : {})
  };
}

function firstQuestionStepId(profile: EventProfile): string {
  return questionStepId(profile, profile.questions[0]!);
}

function firstCreationStepId(profiles: EventProfile[], data: Record<string, unknown>): string {
  const profile = profiles.find((candidate) => candidate.id === singleChoiceValue(data[EVENT_PROFILE_STEP_ID]));
  const spanKind = eventSpanKind(data, profile);
  if (!spanKind) return EVENT_CREATION_SPAN_STEP_ID;
  if (!eventPollPhase(data, profile)) return EVENT_CREATION_POLL_PHASE_STEP_ID;
  if (!profile) return EVENT_PROFILE_STEP_ID;
  const question = profile.questions.find((candidate) => (
    questionAppliesToSpan(profile, candidate, spanKind)
    && !questionComplete(profile, candidate, data)
  ));
  if (question) return questionStepId(profile, question);
  return firstMissingSpanStepId(profile, data) ?? confirmStepId(profile);
}

function nextReviewQuestionStepId(profiles: EventProfile[], state: FlowState): string {
  const profile = profiles.find((candidate) => candidate.id === singleChoiceValue(state.data[EVENT_PROFILE_STEP_ID]));
  if (!profile) return EVENT_PROFILE_STEP_ID;
  const spanKind = eventSpanKind(state.data, profile);
  // Review every applicable question, even when the stored event has an answer.
  const currentQuestionIndex = profile.questions.findIndex((question) => questionStepId(profile, question) === state.currentStepId);
  const nextQuestion = profile.questions.slice(currentQuestionIndex + 1)
    .find((question) => questionAppliesToSpan(profile, question, spanKind));
  if (nextQuestion) return questionStepId(profile, nextQuestion);
  return spanKind === 'multi_day' ? endDateStepId(profile) : confirmStepId(profile);
}

function questionAppliesToSpan(profile: EventProfile, question: EventQuestion, spanKind: EventSpanKind | undefined): boolean {
  return !(spanKind === 'multi_day' && question.key === profile.startsAtTimeQuestionKey);
}

function singleChoiceValue(value: unknown): string | undefined {
  const selected = Array.isArray(value) ? value[0] : value;
  return typeof selected === 'string' ? selected : undefined;
}

function eventSpanKind(data: Record<string, unknown>, profile?: EventProfile): EventSpanKind | undefined {
  const value = singleChoiceValue(data[EVENT_CREATION_SPAN_STEP_ID])
    ?? (profile ? singleChoiceValue(data[spanStepId(profile)]) : undefined);
  return value === 'day_trip' || value === 'multi_day' ? value : undefined;
}

function firstMissingQuestionStepId(profile: EventProfile, data: Record<string, unknown>): string | undefined {
  const question = profile.questions.find((candidate) => !questionComplete(profile, candidate, data));
  return question ? questionStepId(profile, question) : undefined;
}

function firstMissingSpanStepId(profile: EventProfile, data: Record<string, unknown>, askPollPhase = false): string | undefined {
  const spanKind = eventSpanKind(data, profile);
  if (spanKind !== 'day_trip' && spanKind !== 'multi_day') {
    return spanStepId(profile);
  }
  if (askPollPhase && !eventPollPhase(data, profile)) return pollPhaseStepId(profile);
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

function pollPhaseStepId(profile: EventProfile): string {
  return `${EVENT_POLL_PHASE_STEP_ID_PREFIX}${profile.id}`;
}

function eventPollPhase(data: Record<string, unknown>, profile?: EventProfile): 'poll' | 'unplanned' | undefined {
  const value = singleChoiceValue(data[EVENT_CREATION_POLL_PHASE_STEP_ID])
    ?? (profile ? singleChoiceValue(data[pollPhaseStepId(profile)]) : undefined);
  return value === 'poll' || value === 'unplanned' ? value : undefined;
}

function endDateStepId(profile: EventProfile): string {
  return `${EVENT_END_DATE_STEP_ID_PREFIX}${profile.id}`;
}

function endTimeStepId(profile: EventProfile): string {
  return `${EVENT_END_TIME_STEP_ID_PREFIX}${profile.id}`;
}

function questionPrompt(
  t: TranslateFn,
  profile: EventProfile,
  question: EventQuestion,
  data: Record<string, unknown>,
  currentValue?: string | undefined
): string {
  const questionIndex = profile.questions.indexOf(question);
  const priorAnswers = eventQuestionAnswersBefore(profile, data, questionIndex);
  const allowedTokens = profile.questions.slice(0, questionIndex).map((candidate) => candidate.key);
  const authoredPrompt = renderEventConditionalText({
    source: question.prompt,
    allowedTokens,
    values: priorAnswers,
    emptyResult: 'reject',
    field: `questions.${question.key}.prompt`
  })!;
  const optionalSuffix = optionalQuestionPromptSuffix(t, profile, question, priorAnswers);
  const basePrompt = questionPromptByType(t, question, authoredPrompt);
  const prompt = currentValue?.trim()
    ? t('official.community-events.flow.currentValuePrompt', { prompt: basePrompt, current: currentValue.trim() })
    : basePrompt;
  return optionalSuffix ? `${prompt}\n${optionalSuffix}` : prompt;
}

function initialQuestionPrompt(
  t: TranslateFn,
  profile: EventProfile,
  question: EventQuestion,
  data: Record<string, unknown>,
  currentValue?: string | undefined
): string {
  try {
    return questionPrompt(t, profile, question, data, currentValue);
  } catch (error) {
    if (!(error instanceof EventConditionalTextConfigurationError) || error.code !== 'rendered-empty') {
      throw error;
    }
    const basePrompt = questionPromptByType(t, question, question.key);
    return currentValue?.trim()
      ? t('official.community-events.flow.currentValuePrompt', {
          prompt: basePrompt,
          current: currentValue.trim()
        })
      : basePrompt;
  }
}

function safeQuestionPromptForState(
  t: TranslateFn,
  profile: EventProfile,
  question: EventQuestion,
  data: Record<string, unknown>,
  currentValue?: string | undefined
): string {
  try {
    return questionPrompt(t, profile, question, data, currentValue);
  } catch (error) {
    if (!(error instanceof EventConditionalTextConfigurationError)) {
      throw error;
    }
    return t('official.community-events.templateConfigurationInvalid');
  }
}

function initialEventQuestionChoiceOptions(
  profile: EventProfile,
  question: EventQuestion,
  data: Record<string, unknown>
): Array<{ label: string; value: string }> {
  try {
    return eventQuestionChoiceOptions(profile, question, data);
  } catch (error) {
    if (
      !(error instanceof EventConditionalTextConfigurationError)
      || (error.code !== 'rendered-empty' && error.code !== 'duplicate-rendered-values')
    ) {
      throw error;
    }
    return question.choices.map((choice) => ({ label: choice.id, value: choice.id }));
  }
}

function safeEventQuestionChoiceOptions(
  profile: EventProfile,
  question: EventQuestion,
  data: Record<string, unknown>
): Array<{ label: string; value: string }> {
  try {
    return eventQuestionChoiceOptions(profile, question, data);
  } catch (error) {
    if (!(error instanceof EventConditionalTextConfigurationError)) {
      throw error;
    }
    return question.choices.map((choice) => ({ label: choice.id, value: choice.id }));
  }
}

function eventQuestionChoiceOptions(
  profile: EventProfile,
  question: EventQuestion,
  data: Record<string, unknown>
): Array<{ label: string; value: string }> {
  const questionIndex = profile.questions.indexOf(question);
  const priorAnswers = eventQuestionAnswersBefore(profile, data, questionIndex);
  const allowedTokens = profile.questions.slice(0, questionIndex).map((candidate) => candidate.key);
  const options = question.choices.map((choice) => ({
    label: renderEventQuestionChoiceLabel(question, choice, priorAnswers, allowedTokens),
    value: choice.id
  }));
  if (new Set(options.map((option) => option.label.toLowerCase())).size !== options.length) {
    throw new EventConditionalTextConfigurationError(
      `questions.${question.key}.choices`,
      'duplicate-rendered-values'
    );
  }
  return options;
}

function renderEventQuestionChoiceLabel(
  question: EventQuestion,
  choice: EventQuestionChoice,
  priorAnswers: Record<string, string>,
  allowedTokens: string[]
): string {
  return renderEventConditionalText({
    source: choice.label,
    allowedTokens,
    values: priorAnswers,
    emptyResult: 'reject',
    field: `questions.${question.key}.choices.${choice.id}.label`
  })!.trim();
}

function eventQuestionAnswersBefore(
  profile: EventProfile,
  data: Record<string, unknown>,
  endExclusive: number
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const question of profile.questions.slice(0, Math.max(0, endExclusive))) {
    if (data[EVENT_CREATION_SPAN_STEP_ID] && eventSpanKind(data, profile) === 'multi_day'
      && question.key === profile.startsAtTimeQuestionKey) continue;
    const value = eventAnswerValue(data[questionStepId(profile, question)], question, profile, answers);
    if (value) answers[question.key] = value;
  }
  return answers;
}

function questionPromptByType(t: TranslateFn, question: EventQuestion, prompt: string): string {
  if (question.type === EVENT_DATE_QUESTION_TYPE) {
    return t('official.community-events.flow.datePrompt', { prompt });
  }
  if (question.type === EVENT_TIME_QUESTION_TYPE) {
    return t('official.community-events.flow.timePrompt', { prompt });
  }
  return prompt;
}

function optionalQuestionPromptSuffix(
  t: TranslateFn,
  profile: EventProfile,
  question: EventQuestion,
  answers: Record<string, string>
): string {
  if (question.required) {
    return '';
  }
  return profileOptionalPromptSuffix(t, profile, answers);
}

function optionalFlowPrompt(
  t: TranslateFn,
  profile: EventProfile,
  prompt: string,
  data: Record<string, unknown>
): string {
  const suffix = profileOptionalPromptSuffix(
    t,
    profile,
    eventQuestionAnswersBefore(profile, data, profile.questions.length)
  );
  return suffix ? `${prompt}\n${suffix}` : prompt;
}

function profileOptionalPromptSuffix(
  t: TranslateFn,
  profile: EventProfile,
  answers: Record<string, string>
): string {
  const source = profile.optionalPromptSuffix.trim()
    ? profile.optionalPromptSuffix
    : t('official.community-events.flow.optionalPromptSuffix');
  const firstOptionalQuestionIndex = profile.questions.findIndex((question) => !question.required);
  const allowedTokens = profile.questions
    .slice(0, firstOptionalQuestionIndex < 0 ? profile.questions.length : firstOptionalQuestionIndex)
    .map((question) => question.key);
  return renderEventConditionalText({
    source,
    allowedTokens,
    values: answers,
    emptyResult: 'suppress',
    field: 'optionalPromptSuffix'
  }) ?? '';
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
  profile: EventProfile,
  question: EventQuestion,
  value: string,
  data: Record<string, unknown>,
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
    return initialChoiceValue(
      profile,
      question,
      value,
      eventQuestionAnswersBefore(profile, data, profile.questions.indexOf(question))
    );
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

function eventAnswerValue(
  raw: unknown,
  question: EventQuestion,
  profile: EventProfile,
  priorAnswers: Record<string, string>
): string {
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
    const questionIndex = profile.questions.indexOf(question);
    const allowedTokens = profile.questions.slice(0, questionIndex).map((candidate) => candidate.key);
    const choice = question.choices.find((candidate) => {
      const renderedLabel = renderEventQuestionChoiceLabel(question, candidate, priorAnswers, allowedTokens);
      return candidate.id === selected || candidate.label === selected || renderedLabel === selected;
    });
    return choice
      ? renderEventQuestionChoiceLabel(question, choice, priorAnswers, allowedTokens)
      : selected.trim();
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
  const completion = answers ? eventLifecycleCompleteAt({
    localDate: answers.localDate,
    ...(answers.localTime ? { localTime: answers.localTime } : {}),
    endsAt: answers.endsAt,
    spanKind: answers.spanKind,
    timezone
  }) : undefined;
  return Boolean(completion && completion.getTime() <= now.getTime());
}

function initialChoiceValue(
  profile: EventProfile,
  question: EventQuestion,
  value: string,
  priorAnswers: Record<string, string>
): unknown {
  const questionIndex = profile.questions.indexOf(question);
  const allowedTokens = profile.questions.slice(0, questionIndex).map((candidate) => candidate.key);
  const normalizedValue = value.toLowerCase();
  const choice = question.choices.find((candidate) => {
    const renderedLabel = renderEventQuestionChoiceLabel(question, candidate, priorAnswers, allowedTokens);
    return candidate.id.toLowerCase() === normalizedValue
      || candidate.label.toLowerCase() === normalizedValue
      || renderedLabel.toLowerCase() === normalizedValue;
  });
  return choice ? [choice.id] : undefined;
}

function eventConfirmationSummary(state: FlowState, profile: EventProfile, timezone: string, locale: string, t: TranslateFn): string {
  const answers = eventFlowAnswersFromData(state.data, profile, timezone, locale);
  if (!answers) {
    return profile.label;
  }
  const summary = t('official.community-events.flow.confirmSummary', {
    timezone,
    profile: profile.label,
    startsAt: formatEventDateTime(answers.startsAt, timezone, locale),
    endsAt: formatEventDateTime(answers.endsAt, timezone, locale),
    span: t(answers.spanKind === 'day_trip'
      ? 'official.community-events.span.dayTrip'
      : 'official.community-events.span.multiDay')
  });
  return eventPollPhase(state.data, profile)
    ? `${summary}\n${t(answers.pollPhase === 'unplanned'
      ? 'official.community-events.flow.pollPhase.unplanned'
      : 'official.community-events.flow.pollPhase.poll')}`
    : summary;
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
