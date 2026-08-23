import type { EventFlowAnswers } from './flow';
import {
  calendarDescription,
  calendarLocation,
  renderEventTemplate
} from './flow';
import type { EventProfile } from './config';
import type { StoredEventLocation, StoredEventPollOption, StoredEventResponseClass } from './store';
import type { EventSpanKind } from './span';
import { eventDurationMinutes, validEventSpanDuration } from './span';
import { eventLifecycleCompleteAt } from './datetime';

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
  const { profile, answers, timezone, locale, creatorDisplayName } = input;
  const spanKind = answers.spanKind ?? 'day_trip';
  const endsAt = answers.endsAt ?? new Date(
    answers.startsAt.getTime() + profile.calendar.durationMinutes * 60_000
  );
  const pollQuestion = renderEventTemplate({
    template: profile.poll.titleTemplate,
    profile,
    answers: answers.answers,
    startsAt: answers.startsAt,
    endsAt,
    spanKind,
    timezone,
    locale,
    creatorDisplayName
  });
  const groupTitle = renderEventTemplate({
    template: profile.group.titleTemplate,
    profile,
    answers: answers.answers,
    startsAt: answers.startsAt,
    endsAt,
    spanKind,
    timezone,
    locale,
    creatorDisplayName
  });
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
    pollOptions: profile.poll.options.map((option) => ({
      id: option.id,
      label: option.label,
      responseClassId: option.responseClassId
    })),
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
