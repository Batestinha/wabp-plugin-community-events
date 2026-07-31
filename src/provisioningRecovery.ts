import { enqueuePluginJob } from '../../../platform/jobs/queue';
import { isManagedCommunitySubgroupProvisioningError } from '../../../platform/pluginRuntime/runtime/pluginCommunityOperations';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { CreatedGroupParticipantResult } from '../../../platform/transport/transportTypes';
import { voterWidsForResponseBehavior } from './attendance';
import { parseEventsConfig } from './config';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import { resumeEventCommunitySubgroup } from './subgroups';
import {
  appendEventLog,
  checkpointEventProvisioningCandidate,
  eventsDatabase,
  getActiveEventBySubgroup,
  getEvent,
  listCreatedGroupParticipants,
  listVotes,
  markEventProvisioningResumed,
  saveCreatedGroupParticipants,
  type StoredEventRecord
} from './store';

export interface ResumeEventProvisioningInput {
  context: PluginRuntimeContext;
  scopeId: string;
  eventId: string;
  subgroupChatId: string;
  subgroupTitle?: string | undefined;
  participants?: Record<string, CreatedGroupParticipantResult> | undefined;
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
      communityLinkStatus: 'linked' | 'pending';
      communityLinkError?: string | undefined;
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
  const liveParentCommunityChatId = await input.context.communityParentGroupWidForGroup(subgroupChatId);
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
  if (!input.context.services) {
    return rejected(
      event,
      'Provisioning recovery requires the official community subgroup service.'
    );
  }
  let subgroupTitle = input.subgroupTitle?.trim() || event.subgroupTitle || event.groupTitle;
  let participantOutcomes = mergedParticipantOutcomes(
    listCreatedGroupParticipants(db, event.id),
    input.participants
  );
  let communityLinkStatus: 'linked' | 'pending' = 'linked';
  let communityLinkError: string | undefined;
  const resumedAt = (input.now ?? new Date()).toISOString();
  if (event.eventStatus === 'failed' && event.groupLifecycleStatus === 'none') {
    const checkpointed = checkpointEventProvisioningCandidate(db, {
      eventId: event.id,
      scopeId,
      subgroupChatId,
      subgroupTitle,
      participants: participantOutcomes,
      checkpointedAt: resumedAt
    });
    if (!checkpointed) {
      const changedEvent = getEvent(db, event.id) ?? event;
      return rejected(
        changedEvent,
        `Event ${event.id} changed state while its subgroup recovery candidate was being checkpointed.`
      );
    }
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.candidate_checkpointed',
      metadata: {
        subgroupChatId,
        subgroupTitle,
        participantOutcomeCount: Object.keys(participantOutcomes).length,
        actorWid: input.actorWid,
        actorLabel: input.actorLabel
      }
    });
  }
  try {
    const result = await resumeEventCommunitySubgroup({
      context: input.context,
      scopeId,
      actorWid: input.actorWid?.trim() || event.actorWid,
      subgroupChatId,
      subgroupTitle,
      participantWids: attendeeWids,
      participants: participantOutcomes,
      parentCommunityWid: parentCommunityChatId
    });
    const resumedSubgroupChatId = result.created.chatId.trim().toLowerCase();
    if (resumedSubgroupChatId !== subgroupChatId) {
      throw new Error(
        `Subgroup resume returned ${resumedSubgroupChatId}; expected ${subgroupChatId}.`
      );
    }
    subgroupTitle = result.created.title.trim() || subgroupTitle;
    participantOutcomes = mergeParticipantOutcomeRecords(
      participantOutcomes,
      result.created.participants
    );
    communityLinkStatus = result.communityLinkStatus;
    communityLinkError = result.communityLinkError;
    if (event.eventStatus === 'failed' && event.groupLifecycleStatus === 'none') {
      const outputCheckpointed = checkpointEventProvisioningCandidate(db, {
        eventId: event.id,
        scopeId,
        subgroupChatId,
        subgroupTitle,
        participants: participantOutcomes,
        checkpointedAt: resumedAt
      });
      if (!outputCheckpointed) {
        throw new Error(
          `Event ${event.id} changed state while subgroup resume output was being checkpointed.`
        );
      }
    } else {
      saveCreatedGroupParticipants(db, event.id, participantOutcomes);
    }
  } catch (error) {
    if (
      event.eventStatus === 'failed' &&
      event.groupLifecycleStatus === 'none' &&
      isManagedCommunitySubgroupProvisioningError(error) &&
      error.created.chatId.trim().toLowerCase() === subgroupChatId
    ) {
      subgroupTitle = error.created.title.trim() || subgroupTitle;
      participantOutcomes = mergeParticipantOutcomeRecords(
        participantOutcomes,
        error.created.participants
      );
      const failureCheckpointed = checkpointEventProvisioningCandidate(db, {
        eventId: event.id,
        scopeId,
        subgroupChatId,
        subgroupTitle,
        participants: participantOutcomes,
        checkpointedAt: new Date().toISOString(),
        reason: error.message
      });
      appendEventLog(db, {
        eventId: event.id,
        action: 'events.provisioning.resume_failed',
        metadata: {
          reason: error.message,
          subgroupChatId,
          subgroupTitle,
          stage: error.stage,
          progress: provisioningProgress(error.provisioning),
          participants: participantOutcomes,
          checkpointPersisted: failureCheckpointed
        }
      });
    }
    throw error;
  }

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
            provisioningMode: 'service',
            communityLinkStatus,
            communityLinkError,
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
      provisioningMode: 'service',
      communityLinkStatus,
      communityLinkError,
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
      provisioningMode: 'service',
      communityLinkStatus,
      communityLinkError,
      actorWid: input.actorWid,
      actorLabel: input.actorLabel
    }
  });

  return {
    status: 'queued',
    event: queuedEvent,
    resumed,
    attendeeCount: attendeeWids.length,
    parentCommunityChatId,
    communityLinkStatus,
    ...(communityLinkError ? { communityLinkError } : {})
  };
}

export function eventProvisioningResumeDedupeKey(eventId: string, subgroupChatId: string): string {
  return `${EVENTS_JOBS.close}:${eventId}:resume:${subgroupChatId}`;
}

export function mergedParticipantOutcomes(
  stored: ReturnType<typeof listCreatedGroupParticipants>,
  supplied: Record<string, CreatedGroupParticipantResult> | undefined
): Record<string, CreatedGroupParticipantResult> {
  const persisted = Object.fromEntries(stored.map((participant) => [
    participant.wid,
    {
      ...(participant.statusCode !== undefined ? { statusCode: participant.statusCode } : {}),
      ...(participant.message ? { message: participant.message } : {}),
      isGroupCreator: participant.isGroupCreator,
      isInviteV4Sent: participant.isInviteV4Sent
    }
  ]));
  return mergeParticipantOutcomeRecords(persisted, supplied ?? {});
}

export function mergeParticipantOutcomeRecords(
  ...records: Array<Record<string, CreatedGroupParticipantResult>>
): Record<string, CreatedGroupParticipantResult> {
  const merged: Record<string, CreatedGroupParticipantResult> = {};
  for (const record of records) {
    for (const [wid, outcome] of Object.entries(record)) {
      const previous = merged[wid];
      merged[wid] = {
        ...previous,
        ...outcome,
        isGroupCreator: previous?.isGroupCreator === true || outcome.isGroupCreator,
        isInviteV4Sent: previous?.isInviteV4Sent === true || outcome.isInviteV4Sent
      };
    }
  }
  return merged;
}

function provisioningProgress(input: {
  standaloneRegistered: boolean;
  attendeesVerified: boolean;
  communityLinkConfirmed: boolean;
  linkedChildRegistered: boolean;
}): Record<string, boolean> {
  return {
    standaloneRegistered: input.standaloneRegistered,
    attendeesVerified: input.attendeesVerified,
    communityLinkConfirmed: input.communityLinkConfirmed,
    linkedChildRegistered: input.linkedChildRegistered
  };
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
