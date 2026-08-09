import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { CreatedGroupParticipantResult } from '../../../platform/transport/transportTypes';
import type { StoredEventRecord } from './store';

export interface EventVoteSelection {
  voterIdentityId: string;
  voterWid: string;
  selectedOptionIds: string[];
  selectedOptionNames: string[];
  selectedOptionNumbers: number[];
}

export function voterWidsForResponseBehavior(
  record: StoredEventRecord,
  votes: readonly EventVoteSelection[],
  behavior: 'includeInEventGroup' | 'includeInAttendanceCount'
): string[] {
  const responseClassesById = new Map(record.responseClasses.map((responseClass) => [
    responseClass.id,
    responseClass
  ]));
  const optionsById = new Map(record.pollOptions.map((option) => [option.id, option]));
  const votersByIdentityId = new Map<string, string>();
  for (const vote of votes) {
    const selected = selectedEventOptionIds(record, vote);
    if (selected.some((optionId) => {
      const option = optionsById.get(optionId);
      const responseClass = option ? responseClassesById.get(option.responseClassId) : undefined;
      return responseClass?.[behavior] === true;
    })) {
      const voterIdentityId = vote.voterIdentityId.trim();
      const voterWid = vote.voterWid.trim();
      if (!voterIdentityId || !voterWid) {
        throw new Error('Event attendance requires an authoritative voter identity and delivery address.');
      }
      votersByIdentityId.set(voterIdentityId, voterWid);
    }
  }
  return [...votersByIdentityId.values()].sort();
}

export async function missingEventSubgroupAttendeeWids(
  context: Pick<PluginRuntimeContext, 'getGroupParticipants' | 'resolveIdentityAddress'>,
  subgroupChatId: string,
  attendeeWids: readonly string[],
  participantOutcomes: Readonly<Record<string, CreatedGroupParticipantResult>> = {}
): Promise<string[]> {
  return (
    await eventSubgroupAttendeeCoverage(
      context,
      subgroupChatId,
      attendeeWids,
      participantOutcomes
    )
  ).missingAttendeeWids;
}

export interface EventSubgroupAttendeeCoverage {
  presentAttendeeWids: string[];
  pendingInviteWids: string[];
  missingAttendeeWids: string[];
}

export async function eventSubgroupAttendeeCoverage(
  context: Pick<PluginRuntimeContext, 'getGroupParticipants' | 'resolveIdentityAddress'>,
  subgroupChatId: string,
  attendeeWids: readonly string[],
  participantOutcomes: Readonly<Record<string, CreatedGroupParticipantResult>> = {}
): Promise<EventSubgroupAttendeeCoverage> {
  const uniqueAttendeeWids = [...new Set(attendeeWids.map((wid) => wid.trim()).filter(Boolean))];
  if (uniqueAttendeeWids.length === 0) {
    return {
      presentAttendeeWids: [],
      pendingInviteWids: [],
      missingAttendeeWids: []
    };
  }
  if (!context.getGroupParticipants) {
    throw new Error('Plugin runtime does not expose group participant reads.');
  }
  const resolveIdentityAddress = context.resolveIdentityAddress;
  if (!resolveIdentityAddress) {
    throw new Error('Authoritative identity address service is unavailable.');
  }

  const identityIdsByWid = new Map<string, Promise<string>>();
  const identityIdFor = (rawWid: string): Promise<string> => {
    const wid = rawWid.trim();
    if (!wid) {
      return Promise.reject(new Error('Cannot resolve an empty attendee address.'));
    }
    const existing = identityIdsByWid.get(wid);
    if (existing) {
      return existing;
    }
    const resolution = resolveIdentityAddress(wid).then((address) => {
      const identityId = address.identityId?.trim();
      if (!identityId) {
        throw new Error(`Authoritative identity resolution did not return an identity ID for ${wid}.`);
      }
      return identityId;
    });
    identityIdsByWid.set(wid, resolution);
    return resolution;
  };

  const participantWids = (await context.getGroupParticipants(subgroupChatId))
    .map((participant) => participant.wid.trim())
    .filter(Boolean);
  const participantIdentityIds = new Set(await Promise.all(
    [...new Set(participantWids)].map(identityIdFor)
  ));
  const pendingInviteOutcomeWids = [...new Set(
    Object.entries(participantOutcomes)
      .filter(([, outcome]) => outcome.isInviteV4Sent === true)
      .map(([wid]) => wid.trim())
      .filter(Boolean)
  )];
  const pendingInviteIdentityIds = new Set(await Promise.all(
    pendingInviteOutcomeWids.map(identityIdFor)
  ));
  const presentAttendeeWids: string[] = [];
  const pendingInviteWids: string[] = [];
  const missingAttendeeWids: string[] = [];
  const seenAttendeeIdentityIds = new Set<string>();
  for (const attendeeWid of uniqueAttendeeWids) {
    const attendeeIdentityId = await identityIdFor(attendeeWid);
    if (seenAttendeeIdentityIds.has(attendeeIdentityId)) {
      continue;
    }
    seenAttendeeIdentityIds.add(attendeeIdentityId);
    if (participantIdentityIds.has(attendeeIdentityId)) {
      presentAttendeeWids.push(attendeeWid);
    } else if (pendingInviteIdentityIds.has(attendeeIdentityId)) {
      pendingInviteWids.push(attendeeWid);
    } else {
      missingAttendeeWids.push(attendeeWid);
    }
  }
  return {
    presentAttendeeWids: [...new Set(presentAttendeeWids)].sort(),
    pendingInviteWids: [...new Set(pendingInviteWids)].sort(),
    missingAttendeeWids: [...new Set(missingAttendeeWids)].sort()
  };
}

function selectedEventOptionIds(record: StoredEventRecord, vote: EventVoteSelection): string[] {
  const selected = new Set<string>();
  for (const name of vote.selectedOptionNames) {
    const option = record.pollOptions.find((candidate) => candidate.label === name);
    if (option) {
      selected.add(option.id);
    }
  }
  for (const number of vote.selectedOptionNumbers) {
    const option = record.pollOptions[number - 1];
    if (option) {
      selected.add(option.id);
    }
  }
  for (const id of vote.selectedOptionIds) {
    const direct = record.pollOptions.find((candidate) => candidate.id === id);
    if (direct) {
      selected.add(direct.id);
      continue;
    }
    const localId = Number(id);
    if (Number.isSafeInteger(localId) && localId >= 0) {
      const option = record.pollOptions[localId];
      if (option) {
        selected.add(option.id);
      }
    }
  }
  return [...selected];
}
