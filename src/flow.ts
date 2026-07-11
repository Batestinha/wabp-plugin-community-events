import { randomUUID } from 'node:crypto';
import type { FlowDefinition, FlowState, FlowStep } from '../../../adminBot/flows/flowTypes';
import type { FlowSessionSnapshot } from '../../../adminBot/flows/flowEngine';
import type { TranslateFn } from '../../../platform/i18n';
import { EVENT_CHOICE_QUESTION_TYPE, EVENT_DATETIME_QUESTION_TYPE, type EventProfile, type EventQuestion } from './config';
import {
  combineEventDateDraftWithTime,
  eventDateDraft,
  eventDateTemplateTokens,
  eventDateTimeAnswer,
  formatEventDateTime,
  isEventDateDraft,
  isEventDateTimeAnswer,
  parseEventDateTimeInput
} from './datetime';

export const EVENT_PROFILE_STEP_ID = 'profile';

export interface EventFlowAnswers {
  profileId: string;
  answers: Record<string, string>;
  startsAt: Date;
}

export interface EventFlowPrefill {
  profileId?: string | undefined;
  answers: Record<string, string>;
}

export function createEventFlowDefinition(input: {
  t: TranslateFn;
  profiles: EventProfile[];
  prefill?: EventFlowPrefill | undefined;
  timezone?: string | undefined;
  locale?: string | undefined;
  initialData?: Record<string, unknown> | undefined;
  now?: (() => Date) | undefined;
}): FlowDefinition {
  const timezone = input.timezone ?? 'UTC';
  const locale = input.locale ?? 'en';
  const initialData = input.initialData ?? eventInitialFlowData(input.profiles, input.prefill, {
    timezone,
    locale,
    now: input.now?.()
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
      presentation: 'text',
      nextStepIdByValue: Object.fromEntries(input.profiles.map((profile) => [
        profile.id,
        firstQuestionStepId(profile)
      ]))
    }
  };

  for (const profile of input.profiles) {
    const visibleQuestions = initialProfile?.id === profile.id
      ? profile.questions.filter((question) => !questionComplete(profile, question, initialData))
      : profile.questions;
    for (const [index, question] of visibleQuestions.entries()) {
      const nextQuestion = visibleQuestions[index + 1];
      const stepId = questionStepId(profile, question);
      const nextStepId = nextQuestion ? questionStepId(profile, nextQuestion) : confirmStepId(profile);
      if (question.type === EVENT_CHOICE_QUESTION_TYPE) {
        steps[stepId] = {
          id: stepId,
          kind: 'choice',
          prompt: question.prompt,
          options: question.choices.map((choice) => ({ label: choice.label, value: choice.id })),
          minSelections: question.required ? 1 : 0,
          maxSelections: 1,
          presentation: 'text',
          nextStepId
        };
        continue;
      }
      steps[stepId] = {
        id: stepId,
        kind: 'text',
        prompt: question.type === EVENT_DATETIME_QUESTION_TYPE
          ? input.t('official.community-events.flow.datetimePrompt', { prompt: question.prompt })
          : question.prompt,
        nextStepId,
        ...(question.type === EVENT_DATETIME_QUESTION_TYPE
          ? {
              resolveInput: (resolutionInput) => resolveDateTimeQuestionInput({
                t: input.t,
                timezone,
                locale,
                now: input.now,
                input: resolutionInput
              })
            }
          : {})
      };
    }
    steps[confirmStepId(profile)] = {
      id: confirmStepId(profile),
      kind: 'choice',
      prompt: input.t('official.community-events.flow.confirm', { summary: profile.label }),
      promptForState: (state) => input.t('official.community-events.flow.confirm', {
        summary: eventConfirmationSummary(state, profile, timezone, input.t)
      }),
      options: [
        { label: input.t('official.community-events.flow.yes'), value: 'yes' },
        { label: input.t('official.community-events.flow.no'), value: 'no' }
      ],
      minSelections: 1,
      maxSelections: 1,
      presentation: 'text'
    };
  }

  return {
    flowType: `official.community-events.create.${randomUUID()}`,
    t: input.t,
    initialStepId: initialProfile
      ? firstMissingQuestionStepId(initialProfile, initialData) ?? confirmStepId(initialProfile)
      : EVENT_PROFILE_STEP_ID,
    context: 'either',
    timeoutMinutes: 30,
    completionReply: input.t('official.community-events.flow.complete'),
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
      data[questionStepId(profile, question)] = question.type === EVENT_DATETIME_QUESTION_TYPE && options
        ? initialDateTimeValue(value, options)
        : question.type === EVENT_CHOICE_QUESTION_TYPE
          ? initialChoiceValue(question, value)
          : value;
    }
  }
  return data;
}

export function eventConfirmPurpose(flowType: string, profile: EventProfile): string {
  return `flow.${flowType}.${confirmStepId(profile)}`;
}

export function eventFlowConfirmed(snapshot: FlowSessionSnapshot, profile: EventProfile): boolean {
  const value = snapshot.state.data[confirmStepId(profile)];
  return Array.isArray(value) ? value.includes('yes') : value === 'yes';
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
  _timezone: string
): EventFlowAnswers | undefined {
  return eventFlowAnswersFromData(snapshot.state.data, profile);
}

export function eventFlowAnswersFromRaw(input: {
  profile: EventProfile;
  answers: Record<string, string>;
  timezone: string;
  locale: string;
  now?: Date | undefined;
}): EventFlowAnswers | undefined {
  const data: Record<string, unknown> = {
    [EVENT_PROFILE_STEP_ID]: input.profile.id
  };
  for (const question of input.profile.questions) {
    const value = input.answers[question.key]?.trim() ?? '';
    if (!value) {
      continue;
    }
    if (question.type === EVENT_DATETIME_QUESTION_TYPE) {
      const parsed = parseEventDateTimeInput(value, {
        timezone: input.timezone,
        locale: input.locale,
        now: input.now
      });
      if (parsed.status !== 'ok') {
        return undefined;
      }
      data[questionStepId(input.profile, question)] = eventDateTimeAnswer(parsed);
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
  return eventFlowAnswersFromData(data, input.profile);
}

export function renderEventTemplate(input: {
  template: string;
  profile: EventProfile;
  answers: Record<string, string>;
  startsAt: Date;
  timezone: string;
  creatorDisplayName: string;
  extraTokens?: Record<string, string | undefined> | undefined;
}): string {
  const dateTokens = eventDateTemplateTokens(input.startsAt, input.timezone);
  const tokens: Record<string, string> = {
    ...input.answers,
    ...dateTokens,
    profileId: input.profile.id,
    profileLabel: input.profile.label,
    creatorDisplayName: input.creatorDisplayName,
    ...Object.fromEntries(Object.entries(input.extraTokens ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1])))
  };
  return input.template.replace(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g, (_match, key: string) => tokens[key] ?? '');
}

export function selectedOptionLabels(profile: EventProfile): string[] {
  return profile.poll.options.map((option) => option.label);
}

export function calendarLocation(profile: EventProfile, answers: Record<string, string>): string | undefined {
  const key = profile.calendar.locationQuestionKey;
  return key ? answers[key] : undefined;
}

export function calendarDescription(profile: EventProfile, answers: Record<string, string>, startsAt: Date, timezone: string): string | undefined {
  const template = profile.calendar.descriptionTemplate;
  return template
    ? renderEventTemplate({ template, profile, answers, startsAt, timezone, creatorDisplayName: '' }).trim()
    : undefined;
}

function eventFlowAnswersFromData(
  data: Record<string, unknown>,
  profile: EventProfile
): EventFlowAnswers | undefined {
  const answers: Record<string, string> = {};
  let startsAt: Date | undefined;
  for (const question of profile.questions) {
    const raw = data[questionStepId(profile, question)];
    const value = eventAnswerValue(raw, question);
    if (question.required && !value) {
      return undefined;
    }
    if (value) {
      answers[question.key] = value;
    }
    if (question.key === profile.startsAtQuestionKey) {
      startsAt = isEventDateTimeAnswer(raw) ? new Date(raw.iso) : undefined;
      if (!startsAt || !Number.isFinite(startsAt.getTime())) {
        return undefined;
      }
      answers[question.key] = startsAt.toISOString();
    }
  }
  if (!startsAt) {
    return undefined;
  }
  return {
    profileId: profile.id,
    answers,
    startsAt
  };
}

function firstQuestionStepId(profile: EventProfile): string {
  return questionStepId(profile, profile.questions[0]!);
}

function firstMissingQuestionStepId(profile: EventProfile, data: Record<string, unknown>): string | undefined {
  const question = profile.questions.find((candidate) => !questionComplete(profile, candidate, data));
  return question ? questionStepId(profile, question) : undefined;
}

function questionStepId(profile: EventProfile, question: EventQuestion): string {
  return `q-${profile.id}-${question.key}`;
}

function confirmStepId(profile: EventProfile): string {
  return `confirm-${profile.id}`;
}

function resolveDateTimeQuestionInput(input: {
  t: TranslateFn;
  timezone: string;
  locale: string;
  now?: (() => Date) | undefined;
  input: {
    definition: FlowDefinition;
    state: FlowState;
    step: FlowStep;
    input: string;
  };
}): ReturnType<NonNullable<FlowStep['resolveInput']>> {
  const existing = input.input.state.data[input.input.step.id];
  const options = {
    timezone: input.timezone,
    locale: input.locale,
    now: input.now?.()
  };
  const parsed = isEventDateDraft(existing)
    ? combineEventDateDraftWithTime(existing, input.input.input, options)
    : parseEventDateTimeInput(input.input.input, options);
  if (parsed.status === 'ok') {
    return {
      status: 'use-value',
      value: eventDateTimeAnswer(parsed)
    };
  }
  if (parsed.status === 'missing_time') {
    return {
      status: 'error',
      state: {
        ...input.input.state,
        data: {
          ...input.input.state.data,
          [input.input.step.id]: eventDateDraft(parsed)
        }
      },
      reply: input.t('official.community-events.flow.timePrompt', { date: parsed.promptDate })
    };
  }
  return {
    status: 'error',
    reply: dateTimeErrorMessage(input.t, parsed.reason)
  };
}

function initialDateTimeValue(input: string, options: { timezone: string; locale: string; now?: Date | undefined }): unknown {
  const result = parseEventDateTimeInput(input, options);
  if (result.status === 'ok') {
    return eventDateTimeAnswer(result);
  }
  if (result.status === 'missing_time') {
    return eventDateDraft(result);
  }
  return undefined;
}

function questionComplete(profile: EventProfile, question: EventQuestion, data: Record<string, unknown>): boolean {
  const raw = data[questionStepId(profile, question)];
  if (question.type === EVENT_DATETIME_QUESTION_TYPE) {
    return isEventDateTimeAnswer(raw);
  }
  if (question.type === EVENT_CHOICE_QUESTION_TYPE) {
    return Array.isArray(raw) && raw.some((value) => typeof value === 'string' && value.trim().length > 0);
  }
  return typeof raw === 'string' && raw.trim().length > 0;
}

function eventAnswerValue(raw: unknown, question: EventQuestion): string {
  if (question.type === EVENT_DATETIME_QUESTION_TYPE) {
    return isEventDateTimeAnswer(raw) ? raw.iso : '';
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

function initialChoiceValue(question: EventQuestion, value: string): unknown {
  const choice = question.choices.find((candidate) =>
    candidate.id.toLowerCase() === value.toLowerCase() ||
    candidate.label.toLowerCase() === value.toLowerCase()
  );
  return choice ? [choice.id] : undefined;
}

function eventConfirmationSummary(state: FlowState, profile: EventProfile, timezone: string, t: TranslateFn): string {
  const answers = eventFlowAnswersFromData(state.data, profile);
  if (!answers) {
    return profile.label;
  }
  return t('official.community-events.flow.confirmSummary', {
    profile: profile.label,
    startsAt: formatEventDateTime(answers.startsAt, timezone)
  });
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
