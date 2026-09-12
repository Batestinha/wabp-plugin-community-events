import { canonicalTimezone } from '../../../platform/governance/scopes/scopeClock';
import type { EventFlowAnswers } from './flow';
import {
  calendarDescription,
  calendarLocation,
  eventTemplateValues,
  renderEventTemplate
} from './flow';
import {
  EVENT_DATE_TEMPLATE_TOKENS,
  EVENT_PROFILE_TEMPLATE_TOKENS,
  EVENT_SPAN_TEMPLATE_TOKENS,
  type EventProfile
} from './config';
import type { StoredEventLocation, StoredEventPollOption, StoredEventResponseClass } from './store';
import type { EventSpanKind } from './span';
import { eventDurationMinutes, validEventSpanDuration } from './span';
import { eventLifecycleCompleteAt } from './datetime';
import { validatePollContent } from '../../../platform/transport/pollContract';
import {
  EventConditionalTextConfigurationError,
  renderEventConditionalText
} from './template';

export interface MaterializedEventLifecycle {
  pollQuestion: string;
  groupTitle: string;
  pollOptions: StoredEventPollOption[];
  responseClasses: StoredEventResponseClass[];
  answers: Record<string, string>;
  eventLocation?: StoredEventLocation | undefined;
  startsAt: Date;
  endsAt: Date;
  lifecycleCompleteAt: Date;
  spanKind: EventSpanKind;
  localDate: string;
  localTime?: string | undefined;
  place?: string | undefined;
  closeAt: Date;
  cleanupAt: Date;
  calendarDurationMinutes: number;
  calendarLocation?: string | undefined;
  calendarDescription?: string | undefined;
}

type MaterializableEventFlowAnswers = Omit<EventFlowAnswers, 'endsAt' | 'spanKind'> & {
  endsAt?: Date | undefined;
  spanKind?: EventSpanKind | undefined;
};

export function materializeEventLifecycle(input: {
  profile: EventProfile;
  answers: MaterializableEventFlowAnswers;
  timezone: string;
  locale?: string | undefined;
  creatorDisplayName: string;
  eventLocation?: StoredEventLocation | undefined;
}): MaterializedEventLifecycle {
  const { profile, answers, locale, creatorDisplayName } = input;
  const timezone = canonicalTimezone(input.timezone);
  const spanKind = answers.spanKind ?? 'day_trip';
  const endsAt = answers.endsAt ?? new Date(
    answers.startsAt.getTime() + profile.calendar.durationMinutes * 60_000
  );
  const templateInput = {
    profile,
    answers: answers.answers,
    startsAt: answers.startsAt,
    endsAt,
    spanKind,
    timezone,
    locale,
    creatorDisplayName
  };
  const pollQuestion = renderEventTemplate({
    template: profile.poll.titleTemplate,
    ...templateInput
  }).trim();
  const groupTitle = renderEventTemplate({
    template: profile.group.titleTemplate,
    ...templateInput
  }).trim();
  if (!pollQuestion) {
    throw new EventConditionalTextConfigurationError('poll.titleTemplate', 'rendered-empty');
  }
  if (!groupTitle) {
    throw new EventConditionalTextConfigurationError('group.titleTemplate', 'rendered-empty');
  }
  const participantTextTokens = [
    ...profile.questions.map((question) => question.key),
    ...EVENT_DATE_TEMPLATE_TOKENS,
    ...EVENT_PROFILE_TEMPLATE_TOKENS,
    ...EVENT_SPAN_TEMPLATE_TOKENS
  ];
  const participantTextValues = eventTemplateValues(templateInput);
  const pollOptions = profile.poll.options.map((option) => ({
    id: option.id,
    label: renderEventConditionalText({
      source: option.label,
      allowedTokens: participantTextTokens,
      values: participantTextValues,
      emptyResult: 'reject',
      field: `poll.options.${option.id}.label`
    })!.trim(),
    responseClassId: option.responseClassId
  }));
  if (new Set(pollOptions.map((option) => option.label)).size !== pollOptions.length) {
    throw new EventConditionalTextConfigurationError('poll.options', 'duplicate-rendered-values');
  }
  const pollValidation = validatePollContent(pollQuestion, pollOptions.map((option) => option.label));
  if (!pollValidation.titleFits) {
    throw new EventConditionalTextConfigurationError('poll.titleTemplate', 'rendered-too-long');
  }
  if (!pollValidation.optionsFit) {
    throw new EventConditionalTextConfigurationError('poll.options', 'rendered-too-long');
  }
  const closeAt = new Date(answers.startsAt.getTime() - profile.poll.closeOffsetHoursBeforeStart * 3_600_000);
  const durationMinutes = eventDurationMinutes(answers.startsAt, endsAt);
  if (!validEventSpanDuration(spanKind, durationMinutes)) {
    throw new Error(`Invalid ${spanKind} event duration: ${durationMinutes} minutes.`);
  }
  const lifecycleCompleteAt = eventLifecycleCompleteAt({
    localDate: answers.localDate,
    ...(answers.localTime ? { localTime: answers.localTime } : {}),
    endsAt,
    spanKind,
    timezone
  });
  if (!lifecycleCompleteAt) {
    throw new Error(`Unable to materialize event lifecycle boundary in ${timezone}.`);
  }
  const cleanupAt = new Date(
    lifecycleCompleteAt.getTime() + profile.group.cleanupOffsetHoursAfterEnd * 3_600_000
  );
  const location = input.eventLocation?.displayLabel ?? calendarLocation(profile, answers.answers);
  const description = calendarDescription(
    profile,
    answers.answers,
    answers.startsAt,
    timezone,
    locale,
    endsAt,
    spanKind
  );
  return {
    pollQuestion,
    groupTitle,
    pollOptions,
    responseClasses: profile.poll.responseClasses.map((responseClass) => ({
      id: responseClass.id,
      label: responseClass.label,
      includeInEventGroup: responseClass.includeInEventGroup,
      includeInAttendanceCount: responseClass.includeInAttendanceCount
    })),
    answers: answers.answers,
    ...(input.eventLocation ? { eventLocation: input.eventLocation } : {}),
    startsAt: answers.startsAt,
    endsAt,
    lifecycleCompleteAt,
    spanKind,
    localDate: answers.localDate,
    ...(answers.localTime ? { localTime: answers.localTime } : {}),
    ...(location ? { place: input.eventLocation?.displayLabel ?? location } : {}),
    closeAt,
    cleanupAt,
    calendarDurationMinutes: durationMinutes,
    ...(location ? { calendarLocation: location } : {}),
    ...(description ? { calendarDescription: description } : {})
  };
}
