import { canonicalTimezone } from '../../../platform/governance/scopes/scopeClock';
import { eventDateAndTimeToUtc } from './datetime';
import type { EventFlowAnswers } from './flow';

/** Resolve the entered civil times once the existing location selection is complete. */
export function eventAnswersInTimezone(answers: EventFlowAnswers, timezone: string): EventFlowAnswers {
  const zone = canonicalTimezone(timezone);
  const startsAt = localInstant(answers.localDate, answers.localTime ?? '00:00', zone);
  const endsAt = answers.spanKind === 'multi_day'
    ? localInstant(answers.endLocalDate!, answers.endLocalTime ?? '23:59', zone)
    : new Date(startsAt.getTime() + answers.endsAt.getTime() - answers.startsAt.getTime());
  if (endsAt <= startsAt) throw new Error('The event must end after it starts in its location timezone');
  return { ...answers, startsAt, endsAt };
}

function localInstant(date: string, time: string, timezone: string): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!day || !clock) throw new Error('Invalid local event date or time');
  const expected = { year: Number(day[1]), month: Number(day[2]), day: Number(day[3]), hour: Number(clock[1]), minute: Number(clock[2]) };
  const instant = eventDateAndTimeToUtc(expected, expected, timezone);
  if (!instant) throw new Error('Invalid local event date or time');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(instant).map((part) => [part.type, Number(part.value)]));
  if (Object.entries(expected).some(([key, value]) => parts[key] !== value)) {
    throw new Error('The local event time does not exist in its location timezone');
  }
  return instant;
}
