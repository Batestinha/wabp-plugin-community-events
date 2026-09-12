import { createHash } from 'node:crypto';
import type { PluginOperationContext } from './runtime';
import type { PluginRuntimeContext } from './runtime';
import { POLL_ASSISTANT_SCHEMA_VERSION } from './contracts/poll-assistant/domain';
import {
  POLL_ASSISTANT_LIFECYCLE_CANCEL_METHOD,
  POLL_ASSISTANT_LIFECYCLE_ENSURE_METHOD,
  POLL_ASSISTANT_LIFECYCLE_FINALIZE_METHOD,
  POLL_ASSISTANT_LIFECYCLE_INSPECT_METHOD,
  POLL_ASSISTANT_LIFECYCLE_SERVICE_ID,
  pollAssistantLifecycleCancelOutputSchema,
  pollAssistantLifecycleEnsureInputSchema,
  pollAssistantLifecycleEnsureOutputSchema,
  pollAssistantLifecycleFinalizeOutputSchema,
  pollAssistantLifecycleInspectOutputSchema,
  pollAssistantLifecycleSnapshotSchema,
  type PollAssistantLifecycleEnsureInput,
  type PollAssistantLifecycleEnsureOutput,
  type PollAssistantLifecycleFinalizeOutput,
  type PollAssistantLifecycleInspectOutput,
  type PollAssistantLifecycleCancelOutput,
  type PollAssistantLifecycleSnapshot
} from './contracts/poll-assistant/lifecycleServiceApi';
import type { EventVoteSelection } from './attendance';
import { EVENTS_PLUGIN_ID } from './manifest';
import type {
  StoredEventPollOption,
  StoredEventRecord,
  StoredPollAssistantEventAttendanceLifecycle
} from './store';

type ServiceRegistry = NonNullable<
  PluginOperationContext['services'] | PluginRuntimeContext['services']
>;

export interface EventAttendanceLifecycleCaller {
  services?: ServiceRegistry | undefined;
  scopeId: string;
  actorIdentityId: string;
  groupWid: string;
  groupId?: string | undefined;
}

export interface EventAttendanceLifecycleDefinitionInput {
  eventId: string;
  generation: number;
  groupWid: string;
  question: string;
  options: StoredEventPollOption[];
  allowMultipleAnswers: boolean;
  closeAt: string;
}

export class PendingEventAttendanceLifecycleError extends Error {
  override readonly name = 'PendingEventAttendanceLifecycleError';

  constructor(
    message: string,
    readonly phase: 'publication' | 'finalization',
    readonly status?: string | undefined
  ) {
    super(message);
  }
}

export function eventAttendanceLifecycleSourceKey(eventId: string, generation: number): string {
  return `community-events:attendance:${eventId}:${generation}`;
}

export function eventAttendanceLifecycleRequest(
  input: EventAttendanceLifecycleDefinitionInput
): PollAssistantLifecycleEnsureInput {
  const sourceIdempotencyKey = eventAttendanceLifecycleSourceKey(input.eventId, input.generation);
  return pollAssistantLifecycleEnsureInputSchema.parse({
    groupWid: input.groupWid,
    sourceIdempotencyKey,
    presentationOwner: 'source_plugin',
    definition: {
      schemaVersion: POLL_ASSISTANT_SCHEMA_VERSION,
      id: sourceIdempotencyKey,
      purpose: 'measure',
      question: input.question,
      options: input.options.map((option, index) => ({
        id: option.id,
        label: option.label,
        ordinal: index + 1
      })),
      closing: {
        kind: 'deadline',
        deadline: { mode: 'at', closesAt: input.closeAt }
      },
      quorum: { kind: 'none' },
      electorate: { kind: 'members_at_publication' },
      ballotDelivery: 'group',
      voterDisclosure: 'named',
      rule: {
        kind: 'distribution',
        allowMultipleAnswers: input.allowMultipleAnswers
      }
    }
  });
}

export async function preflightEventAttendanceLifecycle(
  caller: EventAttendanceLifecycleCaller,
  request: PollAssistantLifecycleEnsureInput
): Promise<PollAssistantLifecycleInspectOutput> {
  const services = requireServices(caller.services);
  const output = pollAssistantLifecycleInspectOutputSchema.parse(
    await services.call<PollAssistantLifecycleInspectOutput>({
      serviceId: POLL_ASSISTANT_LIFECYCLE_SERVICE_ID,
      method: POLL_ASSISTANT_LIFECYCLE_INSPECT_METHOD,
      scopeId: caller.scopeId,
      actorIdentityId: caller.actorIdentityId,
      ...(caller.groupId ? { groupId: caller.groupId } : {}),
      groupWid: caller.groupWid,
      input: {
        groupWid: request.groupWid,
        sourceIdempotencyKey: request.sourceIdempotencyKey
      }
    })
  );
  if (output.kind === 'found') {
    assertAttendanceLifecycleEnvelope(request, output);
  } else if (output.reason === 'wrong_group') {
    throw new Error(
      'Poll Assistant found the Community Events attendance key in another group.'
    );
  }
  return output;
}

export async function ensureEventAttendanceLifecycle(
  caller: EventAttendanceLifecycleCaller,
  request: PollAssistantLifecycleEnsureInput,
  cutoffAt?: string
): Promise<PollAssistantLifecycleEnsureOutput> {
  const services = requireServices(caller.services);
  const output = pollAssistantLifecycleEnsureOutputSchema.parse(
    await services.call<PollAssistantLifecycleEnsureOutput>({
      serviceId: POLL_ASSISTANT_LIFECYCLE_SERVICE_ID,
      method: POLL_ASSISTANT_LIFECYCLE_ENSURE_METHOD,
      scopeId: caller.scopeId,
      actorIdentityId: caller.actorIdentityId,
      ...(caller.groupId ? { groupId: caller.groupId } : {}),
      groupWid: caller.groupWid,
      input: request
    })
  );
  assertAttendanceLifecycleEnvelope(request, output, cutoffAt);
  return output;
}

export async function inspectEventAttendanceLifecycle(
  caller: EventAttendanceLifecycleCaller,
  lifecycle: StoredPollAssistantEventAttendanceLifecycle
): Promise<PollAssistantLifecycleInspectOutput> {
  const output = await preflightEventAttendanceLifecycle(caller, lifecycle.request);
  if (output.kind === 'found') {
    assertAttendanceLifecycleEnvelope(lifecycle.request, output);
    assertStoredAttendanceLifecycleReferences(lifecycle, output);
  }
  return output;
}

export async function finalizeEventAttendanceLifecycle(
  caller: EventAttendanceLifecycleCaller,
  lifecycle: StoredPollAssistantEventAttendanceLifecycle,
  cutoffAt?: string
): Promise<PollAssistantLifecycleFinalizeOutput> {
  const services = requireServices(caller.services);
  const output = pollAssistantLifecycleFinalizeOutputSchema.parse(
    await services.call<PollAssistantLifecycleFinalizeOutput>({
      serviceId: POLL_ASSISTANT_LIFECYCLE_SERVICE_ID,
      method: POLL_ASSISTANT_LIFECYCLE_FINALIZE_METHOD,
      scopeId: caller.scopeId,
      actorIdentityId: caller.actorIdentityId,
      ...(caller.groupId ? { groupId: caller.groupId } : {}),
      groupWid: caller.groupWid,
      input: {
        groupWid: lifecycle.request.groupWid,
        sourceIdempotencyKey: lifecycle.sourceIdempotencyKey,
        finalizationIdempotencyKey: `${lifecycle.sourceIdempotencyKey}:finalize`,
        ...(cutoffAt ? { cutoffAt } : {})
      }
    })
  );
  assertAttendanceLifecycleEnvelope(lifecycle.request, output, cutoffAt);
  assertStoredAttendanceLifecycleReferences(lifecycle, output);
  return output;
}

export async function cancelEventAttendanceLifecycle(
  caller: EventAttendanceLifecycleCaller,
  lifecycle: StoredPollAssistantEventAttendanceLifecycle,
  reason: string,
  cutoffAt?: string
): Promise<{
  acknowledgedAt: string;
  lifecycle: PollAssistantLifecycleCancelOutput;
}> {
  const services = requireServices(caller.services);
  const output = pollAssistantLifecycleCancelOutputSchema.parse(
    await services.call({
      serviceId: POLL_ASSISTANT_LIFECYCLE_SERVICE_ID,
      method: POLL_ASSISTANT_LIFECYCLE_CANCEL_METHOD,
      scopeId: caller.scopeId,
      actorIdentityId: caller.actorIdentityId,
      ...(caller.groupId ? { groupId: caller.groupId } : {}),
      groupWid: caller.groupWid,
      input: {
        groupWid: lifecycle.request.groupWid,
        sourceIdempotencyKey: lifecycle.sourceIdempotencyKey,
        cancellationIdempotencyKey: `${lifecycle.sourceIdempotencyKey}:cancel`,
        reason
      }
    })
  );
  assertAttendanceLifecycleEnvelope(lifecycle.request, output, cutoffAt ?? lifecycle.snapshot?.cutoffAt);
  assertStoredAttendanceLifecycleReferences(lifecycle, output);
  return {
    acknowledgedAt: new Date().toISOString(),
    lifecycle: output
  };
}

export function pollAssistantAttendanceLifecycle(
  event: StoredEventRecord
): StoredPollAssistantEventAttendanceLifecycle | undefined {
  return event.attendanceLifecycle?.owner === 'poll_assistant'
    ? event.attendanceLifecycle
    : undefined;
}

export function requirePollAssistantAttendanceLifecycle(
  event: StoredEventRecord
): StoredPollAssistantEventAttendanceLifecycle {
  const lifecycle = pollAssistantAttendanceLifecycle(event);
  if (!lifecycle) {
    throw new Error(`Event ${event.id} is not owned by Poll Assistant.`);
  }
  if (lifecycle.generation !== event.pollGeneration) {
    throw new Error(`Event ${event.id} has a stale Poll Assistant attendance generation.`);
  }
  return lifecycle;
}

export function validateEventAttendanceSnapshot(input: {
  event: StoredEventRecord;
  lifecycle: StoredPollAssistantEventAttendanceLifecycle;
  snapshot: PollAssistantLifecycleSnapshot;
  snapshotSha256: string;
}): PollAssistantLifecycleSnapshot {
  const snapshot = pollAssistantLifecycleSnapshotSchema.parse(input.snapshot);
  const calculatedSha256 = createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex');
  if (calculatedSha256 !== input.snapshotSha256) {
    throw new Error(`Event ${input.event.id} received a mismatched attendance snapshot digest.`);
  }
  if (
    snapshot.sourcePluginId !== EVENTS_PLUGIN_ID
    || snapshot.sourceIdempotencyKey !== input.lifecycle.sourceIdempotencyKey
    || snapshot.groupWid !== input.lifecycle.request.groupWid
    || snapshot.pollId !== input.lifecycle.pollId
    || snapshot.roundId !== input.lifecycle.roundId
    || snapshot.cutoffAt !== input.event.closeAt
    || (input.event.pollWaMsgId && snapshot.pollWaMessageId !== input.event.pollWaMsgId)
  ) {
    throw new Error(`Event ${input.event.id} received a snapshot for another attendance lifecycle.`);
  }
  const optionIds = new Set(input.event.pollOptions.map((option) => option.id));
  for (const ballot of snapshot.ballots) {
    if (ballot.selectedOptionIds.some((optionId) => !optionIds.has(optionId))) {
      throw new Error(`Event ${input.event.id} snapshot contains an unknown attendance option.`);
    }
  }
  return snapshot;
}

export function eventAttendanceVotesFromSnapshot(
  event: StoredEventRecord,
  snapshot: PollAssistantLifecycleSnapshot
): EventVoteSelection[] {
  const optionById = new Map(event.pollOptions.map((option, index) => [
    option.id,
    { option, number: index + 1 }
  ]));
  return snapshot.ballots.map((ballot) => {
    const selections = ballot.selectedOptionIds.map((optionId) => {
      const selection = optionById.get(optionId);
      if (!selection) {
        throw new Error(`Event ${event.id} snapshot contains unknown option ${optionId}.`);
      }
      return selection;
    });
    return {
      voterIdentityId: ballot.voterIdentityId,
      voterWid: ballot.voterWid,
      selectedOptionIds: [...ballot.selectedOptionIds],
      selectedOptionNames: selections.map(({ option }) => option.label),
      selectedOptionNumbers: selections.map(({ number }) => number)
    };
  });
}

export function eventAttendanceSnapshotSha256(snapshot: PollAssistantLifecycleSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function assertAttendanceLifecycleEnvelope(
  request: PollAssistantLifecycleEnsureInput,
  output: Exclude<PollAssistantLifecycleInspectOutput, { kind: 'unavailable' }>
    | PollAssistantLifecycleEnsureOutput
    | PollAssistantLifecycleFinalizeOutput
    | ReturnType<typeof pollAssistantLifecycleCancelOutputSchema.parse>,
  cutoffAt?: string
): void {
  const expectedOptions = request.definition.options.map((option) => ({
    id: option.id,
    label: option.label,
    ordinal: option.ordinal
  }));
  const expectedClosesAt = request.definition.closing.kind === 'deadline'
    && request.definition.closing.deadline.mode === 'at'
    ? request.definition.closing.deadline.closesAt
    : null;
  if (
    output.sourcePluginId !== EVENTS_PLUGIN_ID
    || output.sourceIdempotencyKey !== request.sourceIdempotencyKey
    || output.groupWid !== request.groupWid
    || output.presentationOwner !== 'source_plugin'
    || output.question !== request.definition.question
    || output.allowMultipleAnswers !== (
      request.definition.purpose === 'measure'
      && request.definition.rule.kind === 'distribution'
      && request.definition.rule.allowMultipleAnswers
    )
    || (output.closesAt !== expectedClosesAt && output.closesAt !== cutoffAt)
    || JSON.stringify(output.options) !== JSON.stringify(expectedOptions)
  ) {
    throw new Error('Poll Assistant returned a conflicting Community Events attendance lifecycle.');
  }
}

function assertStoredAttendanceLifecycleReferences(
  lifecycle: StoredPollAssistantEventAttendanceLifecycle,
  output: { pollId: string; roundId: string }
): void {
  if (
    (lifecycle.pollId && lifecycle.pollId !== output.pollId)
    || (lifecycle.roundId && lifecycle.roundId !== output.roundId)
  ) {
    throw new Error('Poll Assistant returned conflicting persisted attendance references.');
  }
}

function requireServices(services: ServiceRegistry | undefined): ServiceRegistry {
  if (!services) {
    throw new Error('Poll Assistant lifecycle service is unavailable.');
  }
  return services;
}
