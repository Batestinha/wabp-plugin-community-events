import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { CreatedGroupParticipantResult } from '../../../platform/transport/transportTypes';
import type { StoredEventRecord } from './store';

export interface EventVoteSelection {
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
  const voters = new Set<string>();
  for (const vote of votes) {
    const selected = selectedEventOptionIds(record, vote);
    if (selected.some((optionId) => {
      const option = optionsById.get(optionId);
      const responseClass = option ? responseClassesById.get(option.responseClassId) : undefined;
      return responseClass?.[behavior] === true;
    })) {
      voters.add(vote.voterWid);
    }
  }
  return [...voters].sort();
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
  if (!context.getGroupParticipants) {
    throw new Error('Plugin runtime does not expose group participant reads.');
  }
  const participantWids = new Set(
    (await context.getGroupParticipants(subgroupChatId))
      .map((participant) => participant.wid.trim())
      .filter(Boolean)
  );
  const presentAttendeeWids: string[] = [];
  const pendingInviteWids: string[] = [];
  const missingAttendeeWids: string[] = [];
  for (const attendeeWid of attendeeWids) {
    if (!context.resolveIdentityAddress) {
      throw new Error('Authoritative identity address service is unavailable.');
    }
    const aliases = (await context.resolveIdentityAddress(attendeeWid)).aliases;
    const candidateWids = [...new Set(
      [attendeeWid, ...aliases].map((wid) => wid.trim()).filter(Boolean)
    )];
    if (candidateWids.some((alias) => participantWids.has(alias))) {
      presentAttendeeWids.push(attendeeWid);
    } else if (candidateWids.some((alias) => participantOutcomes[alias]?.isInviteV4Sent === true)) {
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
