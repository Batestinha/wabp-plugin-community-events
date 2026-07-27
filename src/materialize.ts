import type { EventFlowAnswers } from './flow';
import {
  calendarDescription,
  calendarLocation,
  renderEventTemplate
} from './flow';
import type { EventProfile } from './config';
import type { StoredEventLocation, StoredEventPollOption, StoredEventResponseClass } from './store';

export interface MaterializedEventLifecycle {
  pollQuestion: string;
  groupTitle: string;
  pollOptions: StoredEventPollOption[];
  responseClasses: StoredEventResponseClass[];
  answers: Record<string, string>;
  eventLocation?: StoredEventLocation | undefined;
  startsAt: Date;
  localDate: string;
  localTime?: string | undefined;
  place?: string | undefined;
  style?: string | undefined;
  closeAt: Date;
  cleanupAt: Date;
  calendarDurationMinutes: number;
  calendarLocation?: string | undefined;
  calendarDescription?: string | undefined;
}

export function materializeEventLifecycle(input: {
  profile: EventProfile;
  answers: EventFlowAnswers;
  timezone: string;
  locale?: string | undefined;
  creatorDisplayName: string;
  eventLocation?: StoredEventLocation | undefined;
}): MaterializedEventLifecycle {
  const { profile, answers, timezone, locale, creatorDisplayName } = input;
  const pollQuestion = renderEventTemplate({
    template: profile.poll.titleTemplate,
    profile,
    answers: answers.answers,
    startsAt: answers.startsAt,
    timezone,
    locale,
    creatorDisplayName
  });
  const groupTitle = renderEventTemplate({
    template: profile.group.titleTemplate,
    profile,
    answers: answers.answers,
    startsAt: answers.startsAt,
    timezone,
    locale,
    creatorDisplayName
  });
  const closeAt = new Date(answers.startsAt.getTime() - profile.poll.closeOffsetHoursBeforeStart * 3_600_000);
  const cleanupAt = new Date(answers.startsAt.getTime() + profile.group.cleanupOffsetHoursAfterStart * 3_600_000);
  const location = input.eventLocation?.displayLabel ?? calendarLocation(profile, answers.answers);
  const description = calendarDescription(profile, answers.answers, answers.startsAt, timezone, locale);
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
    localDate: answers.localDate,
    ...(answers.localTime ? { localTime: answers.localTime } : {}),
    ...(answers.answers.place ? { place: answers.answers.place } : {}),
    ...(answers.answers.style ? { style: answers.answers.style } : {}),
    closeAt,
    cleanupAt,
    calendarDurationMinutes: profile.calendar.durationMinutes,
    ...(location ? { calendarLocation: location } : {}),
    ...(description ? { calendarDescription: description } : {})
  };
}
