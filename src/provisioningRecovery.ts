import { enqueuePluginJob } from '../../../platform/jobs/queue';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { missingEventSubgroupAttendeeWids, voterWidsForResponseBehavior } from './attendance';
import { parseEventsConfig } from './config';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import {
  appendEventLog,
  eventsDatabase,
  getActiveEventBySubgroup,
  getEvent,
  listVotes,
  markEventProvisioningResumed,
  type StoredEventRecord
} from './store';

export interface ResumeEventProvisioningInput {
  context: PluginRuntimeContext;
  linkCommunityGroup?(childGroupChatId: string, parentCommunityChatId: string): Promise<void>;
  scopeId: string;
  eventId: string;
  subgroupChatId: string;
  subgroupTitle?: string | undefined;
  actorWid?: string | undefined;
  actorLabel?: string | undefined;
  now?: Date | undefined;
}

export type ResumeEventProvisioningResult =
  | {
      status: 'queued';
      event: StoredEventRecord;
      resumed: boolean;
      attendeeCount: number;
      parentCommunityChatId: string;
    }
  | {
      status: 'already_completed';
      event: StoredEventRecord;
    }
  | {
      status: 'not_found';
      reason: string;
    }
  | {
      status: 'rejected';
      reason: string;
      event: StoredEventRecord;
      missingAttendeeWids?: string[] | undefined;
    };

export async function resumeEventProvisioning(
  input: ResumeEventProvisioningInput
): Promise<ResumeEventProvisioningResult> {
  const scopeId = input.scopeId.trim();
  const eventId = input.eventId.trim();
  const subgroupChatId = input.subgroupChatId.trim().toLowerCase();
  const db = eventsDatabase(input.context.databases);
  const event = getEvent(db, eventId);
  if (!event || event.scopeId !== scopeId) {
    return {
      status: 'not_found',
      reason: `Unknown event ${eventId} in scope ${scopeId}.`
    };
  }

  if (completedWithSubgroup(event, subgroupChatId)) {
    return { status: 'already_completed', event };
  }
  if (!recoverableWithSubgroup(event, subgroupChatId)) {
    return rejected(
      event,
      `Event ${event.id} cannot resume from ${event.eventStatus}/${event.groupLifecycleStatus} with subgroup ${subgroupChatId}.`
    );
  }

  const activeConflict = getActiveEventBySubgroup(db, subgroupChatId);
  if (activeConflict && activeConflict.id !== event.id) {
    return rejected(
      event,
      `Subgroup ${subgroupChatId} is already attached to active event ${activeConflict.id}.`
    );
  }

  const config = parseEventsConfig(await input.context.configFor(scopeId));
  if (!config.eventProfiles.some((profile) => profile.id === event.profileId)) {
    return rejected(event, `Event profile ${event.profileId} is no longer configured for scope ${scopeId}.`);
  }
  if (!input.context.botCapabilitiesFor) {
    return rejected(event, 'Plugin runtime does not expose group capability checks.');
  }
  const capabilities = await input.context.botCapabilitiesFor(subgroupChatId);
  if (
    !capabilities?.botIsMember ||
    (!capabilities.botIsAdmin && !capabilities.botIsSuperAdmin) ||
    !capabilities.canRemoveMembers
  ) {
    return rejected(
      event,
      `The bot must be a member and group admin with member-removal permission in subgroup ${subgroupChatId}.`
    );
  }

  if (!input.context.communityGroupWidForScope || !input.context.communityParentGroupWidForGroup) {
    return rejected(event, 'Plugin runtime does not expose community relationship checks.');
  }
  const parentCommunityChatId = await input.context.communityGroupWidForScope(scopeId);
  if (!parentCommunityChatId) {
    return rejected(event, `No parent community is mapped for scope ${scopeId}.`);
  }
  let liveParentCommunityChatId = await input.context.communityParentGroupWidForGroup(subgroupChatId);
  if (liveParentCommunityChatId && liveParentCommunityChatId !== parentCommunityChatId) {
    return rejected(
      event,
      `Subgroup ${subgroupChatId} belongs to ${liveParentCommunityChatId}, not ${parentCommunityChatId}.`
    );
  }

  const attendeeWids = voterWidsForResponseBehavior(
    event,
    listVotes(db, event.id),
    'includeInEventGroup'
  );
  if (attendeeWids.length === 0) {
    return rejected(event, `Event ${event.id} has no persisted event-group attendees to verify.`);
  }
  const missingAttendeeWids = await missingEventSubgroupAttendeeWids(
    input.context,
    subgroupChatId,
    attendeeWids
  );
  if (missingAttendeeWids.length > 0) {
    return {
      ...rejected(
        event,
        `Subgroup ${subgroupChatId} is missing attendee(s): ${missingAttendeeWids.join(', ')}.`
      ),
      missingAttendeeWids
    };
  }

  if (!liveParentCommunityChatId) {
    if (!input.linkCommunityGroup) {
      return rejected(event, 'Plugin runtime does not expose community subgroup linking.');
    }
    let linkError: unknown;
    try {
      await input.linkCommunityGroup(subgroupChatId, parentCommunityChatId);
    } catch (error) {
      linkError = error;
    }
    liveParentCommunityChatId = await input.context.communityParentGroupWidForGroup(subgroupChatId);
    if (liveParentCommunityChatId !== parentCommunityChatId) {
      if (linkError) {
        throw linkError;
      }
      return rejected(
        event,
        `Subgroup ${subgroupChatId} did not link to parent community ${parentCommunityChatId}.`
      );
    }
  }

  if (!input.context.registerManagedGroup) {
    return rejected(event, 'Plugin runtime does not expose managed-group registration.');
  }
  const subgroupTitle = input.subgroupTitle?.trim() || event.subgroupTitle || event.groupTitle;
  await input.context.registerManagedGroup({
    scopeId,
    chatId: subgroupChatId,
    displayName: subgroupTitle
  });

  const resumedAt = (input.now ?? new Date()).toISOString();
  let resumed = false;
  if (event.eventStatus === 'failed' && event.groupLifecycleStatus === 'none') {
    resumed = db.transaction(() => {
      const changed = markEventProvisioningResumed(db, {
        eventId: event.id,
        scopeId,
        subgroupChatId,
        subgroupTitle,
        resumedAt
      });
      if (changed) {
        appendEventLog(db, {
          eventId: event.id,
          action: 'events.provisioning.resumed',
          metadata: {
            subgroupChatId,
            subgroupTitle,
            attendeeCount: attendeeWids.length,
            parentCommunityChatId,
            actorWid: input.actorWid,
            actorLabel: input.actorLabel
          }
        });
      }
      return changed;
    });
  }

  const queuedEvent = getEvent(db, event.id);
  if (
    !queuedEvent ||
    queuedEvent.eventStatus !== 'active' ||
    queuedEvent.groupLifecycleStatus !== 'poll_open' ||
    queuedEvent.subgroupChatId !== subgroupChatId
  ) {
    return rejected(
      queuedEvent ?? event,
      `Event ${event.id} changed state while provisioning recovery was being prepared.`
    );
  }

  await enqueuePluginJob(input.context.queue, {
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.close,
    scopeId: queuedEvent.scopeId,
    ...(queuedEvent.groupId ? { groupId: queuedEvent.groupId } : {}),
    ...(queuedEvent.groupWid ? { groupWid: queuedEvent.groupWid } : {}),
    payload: { eventId: queuedEvent.id },
    dedupeKey: eventProvisioningResumeDedupeKey(queuedEvent.id, subgroupChatId)
  });
  await appendRecoveryJsonLog(input.context, {
    action: 'event.provisioning_resume_queued',
    scopeId: queuedEvent.scopeId,
    eventId: queuedEvent.id,
    actorWid: input.actorWid,
    profileId: queuedEvent.profileId,
    ...(queuedEvent.pollWaMsgId ? { pollWaMsgId: queuedEvent.pollWaMsgId } : {}),
    subgroupChatId,
    metadata: {
      resumed,
      attendeeCount: attendeeWids.length,
      parentCommunityChatId,
      actorLabel: input.actorLabel
    }
  });
  await input.context.audit.record({
    scopeId: queuedEvent.scopeId,
    ...(queuedEvent.groupId ? { groupId: queuedEvent.groupId } : {}),
    action: resumed
      ? 'official.community-events.provisioning.resumed'
      : 'official.community-events.provisioning.resume_requeued',
    targetJson: {
      eventId: queuedEvent.id,
      subgroupChatId
    },
    metadataJson: {
      attendeeCount: attendeeWids.length,
      parentCommunityChatId,
      actorWid: input.actorWid,
      actorLabel: input.actorLabel
    }
  });

  return {
    status: 'queued',
    event: queuedEvent,
    resumed,
    attendeeCount: attendeeWids.length,
    parentCommunityChatId
  };
}

export function eventProvisioningResumeDedupeKey(eventId: string, subgroupChatId: string): string {
  return `${EVENTS_JOBS.close}:${eventId}:resume:${subgroupChatId}`;
}

function recoverableWithSubgroup(event: StoredEventRecord, subgroupChatId: string): boolean {
  if (event.eventStatus === 'failed' && event.groupLifecycleStatus === 'none') {
    return !event.subgroupChatId || event.subgroupChatId === subgroupChatId;
  }
  return event.eventStatus === 'active' &&
    event.groupLifecycleStatus === 'poll_open' &&
    event.subgroupChatId === subgroupChatId;
}

function completedWithSubgroup(event: StoredEventRecord, subgroupChatId: string): boolean {
  if (event.subgroupChatId !== subgroupChatId) {
    return false;
  }
  return (
    event.eventStatus === 'active' &&
    (event.groupLifecycleStatus === 'poll_closed' || event.groupLifecycleStatus === 'cleanup_failed')
  ) || (
    event.eventStatus === 'completed' &&
    event.groupLifecycleStatus === 'cleaned'
  );
}

function rejected(event: StoredEventRecord, reason: string): Extract<
  ResumeEventProvisioningResult,
  { status: 'rejected' }
> {
  return { status: 'rejected', reason, event };
}

async function appendRecoveryJsonLog(
  context: PluginRuntimeContext,
  entry: Parameters<typeof appendScopeEventJsonLog>[0]['entry']
): Promise<void> {
  try {
    await appendScopeEventJsonLog({ appConfig: context.config, entry });
  } catch (error) {
    context.logger.warn(
      { error, action: entry.action, scopeId: entry.scopeId },
      'Unable to append official.community-events provisioning recovery JSONL log'
    );
  }
}
