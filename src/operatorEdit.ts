import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { eventOperatorEditInputSchema } from './operatorActions';
import type { PluginOperationContext } from './runtime';
import { requireOfficialCommandRuntime } from './runtime';
import { applyEventUpdate, eventIsEditable, eventUpdatePrefill, type EventTextTransport, type EventUpdateDraft } from './commands';
import { localizeDefaultEventProfiles, parseEventsConfig } from './config';
import { eventFlowAnswersFromRaw } from './flow';
import { eventLocationQuery, fixedEventLocation } from './eventLocation';
import { EVENTS_PLUGIN_ID } from './manifest';
import { eventsDatabase, getEvent, type StoredEventLocation } from './store';

export type EventOperatorEditInput = z.infer<typeof eventOperatorEditInputSchema>;
export { eventOperatorEditInputSchema };

/**
 * Applies an operator correction through the same update path as /event edit,
 * acting as the event's creator so titles, polls, subgroup and calendar change together.
 */
export async function editEventFromOperator(input: {
  context: PluginOperationContext;
  transport: EventTextTransport;
  request: EventOperatorEditInput;
}): Promise<Record<string, unknown>> {
  const { request } = input;
  const runtime = requireOfficialCommandRuntime(input.context);
  const db = eventsDatabase(runtime.databases);
  const event = getEvent(db, request.eventId);
  if (!event || event.scopeId !== request.scopeId) {
    return { status: 'not_found', reason: `Unknown event ${request.eventId} in scope ${request.scopeId}.` };
  }
  if (!eventIsEditable(event)) return { status: 'rejected', reason: 'The event cannot be edited in its current state.' };
  if (event.updatedAt !== request.expectedUpdatedAt) {
    return { status: 'conflict', reason: 'The event changed since it was read.', currentUpdatedAt: event.updatedAt };
  }
  const creatorIdentityId = event.actorIdentityId;
  if (!creatorIdentityId) return { status: 'rejected', reason: 'The event has no creator identity to act for.' };
  const t = await input.context.i18n.translatorForIdentity(creatorIdentityId, event.scopeId);
  const locale = (await input.context.i18n.resolveScopeLocale(event.scopeId)).locale;
  const config = parseEventsConfig(await runtime.configFor(event.scopeId, creatorIdentityId));
  const profiles = localizeDefaultEventProfiles(config.eventProfiles, t);
  const profile = profiles.find((candidate) => candidate.id === event.profileId);
  if (!profile) return { status: 'rejected', reason: `Unknown event profile ${event.profileId}.` };
  for (const key of Object.keys(request.answers)) {
    if (!profile.questions.some((question) => question.key === key)) return { status: 'rejected', reason: `Unknown event field ${key}.` };
  }
  const baseline = eventUpdatePrefill(event, profile);
  const answers = eventFlowAnswersFromRaw({
    profile, answers: { ...baseline.answers, ...request.answers }, timezone: event.timezone, locale,
    spanKind: baseline.spanKind, endLocalDate: baseline.endLocalDate, endLocalTime: baseline.endLocalTime,
    allowPast: event.groupLifecycleStatus !== 'poll_open'
  });
  if (!answers) return { status: 'rejected', reason: 'The changed answers are not valid for this event.' };
  const query = eventLocationQuery(profile, answers.answers);
  const fixed = fixedEventLocation(profile, event.timezone);
  let location: StoredEventLocation | undefined = fixed;
  if (!location && request.location === 'keep-coordinates' && event.eventLocation && query) {
    location = { ...event.eventLocation, displayLabel: query };
  } else if (!location && request.location && request.location !== 'keep-coordinates') {
    location = request.location;
  } else if (!location && event.eventLocation?.displayLabel === query) {
    location = event.eventLocation;
  }
  if (!location || (!fixed && location.displayLabel !== query)) {
    return { status: 'rejected', reason: 'A changed place needs location: "keep-coordinates" or new coordinates.' };
  }
  const createdAt = new Date().toISOString();
  const draft: EventUpdateDraft = {
    flowSessionId: `operator-edit:${randomUUID()}`, flowType: 'operator', scopeId: event.scopeId, chatId: event.actorWid,
    eventId: event.id, eventUpdatedAt: event.updatedAt, requestedTitle: event.groupTitle, sourcePluginId: EVENTS_PLUGIN_ID,
    actorWid: event.actorWid, actorIdentityId: creatorIdentityId, creatorIdentityId, actorLabel: event.actorLabel,
    timezone: event.timezone, locale, profile, profiles, calendars: config.calendars, prefill: baseline, createdAt,
    ...(event.groupId ? { groupId: event.groupId } : {}), ...(event.groupWid ? { groupWid: event.groupWid } : {})
  };
  const result = await applyEventUpdate({
    context: input.context, runtime, activeTransport: input.transport, responseChatId: event.actorWid, draft,
    eventId: event.id, answers, eventLocation: location, pastCompletionConfirmed: request.confirmPastCompletion, t, notify: false
  });
  const updated = getEvent(db, event.id);
  return {
    ...result,
    eventId: event.id,
    previousTitle: event.groupTitle,
    ...(updated ? { groupTitle: updated.groupTitle, pollQuestion: updated.pollQuestion, subgroupTitle: updated.subgroupTitle,
      updatedAt: updated.updatedAt } : {})
  };
}
