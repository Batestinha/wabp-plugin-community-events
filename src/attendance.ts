import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
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
  context: Pick<PluginRuntimeContext, 'getGroupParticipants' | 'resolvePrivateRecipient'>,
  subgroupChatId: string,
  attendeeWids: readonly string[]
): Promise<string[]> {
  if (!context.getGroupParticipants) {
    throw new Error('Plugin runtime does not expose group participant reads.');
  }
  const participantWids = new Set(
    (await context.getGroupParticipants(subgroupChatId))
      .map((participant) => participant.wid.trim())
      .filter(Boolean)
  );
  const missing: string[] = [];
  for (const attendeeWid of attendeeWids) {
    const aliases = context.resolvePrivateRecipient
      ? (await context.resolvePrivateRecipient(attendeeWid)).aliases
      : [attendeeWid];
    if (![attendeeWid, ...aliases].some((alias) => participantWids.has(alias))) {
      missing.push(attendeeWid);
    }
  }
  return [...new Set(missing)].sort();
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
