import { z } from 'zod';
import type { ManagedGroupExternalActionContext } from '@wabs/plugin-sdk/managed-group-plugin';
import type { PluginExternalActionRegistration } from '@wabs/plugin-sdk/external-actions';
import type { EventsDeploymentConfig } from './deploymentConfig';
import type { SendTextOptions } from '@wabs/plugin-sdk/transport';
import { adoptEventLifecycle } from './adoption';
import { cancelEventLifecycle } from './cancellation';
import { replayInitialEventCalendarHint } from './eventCalendarHintReplay';
import { publishEventCalendarFromOperator } from './eventCalendarPublication';
import { recoverEventJobs } from './hooks';
import { EVENTS_JOBS } from './manifest';
import { enqueueEventPreCreateProvisioningRecovery, resumeEventProvisioningFromOperator } from './provisioningRecovery';
import { replaceRejectedEventChildFromOperator } from './legacyChildReplacement';
import { eventsDatabase, getEvent, getEventRequiredCreatorReference, retryEventArtifactDeletionCleanup } from './store';
import { requireOfficialCommandRuntime } from './runtime';
import { eventOperatorActionSchemas, eventOperatorActionDeclarations } from './operatorActions';

const OPERATOR_CONSOLE_ACTOR_WID = 'operator-console@system';

export function registerEventsExternalActions(registration: ManagedGroupExternalActionContext<EventsDeploymentConfig>): PluginExternalActionRegistration[] {
  const commandContext = () => {
    if (!registration.commandContext) throw new Error('Host command capabilities are unavailable.');
    return registration.commandContext();
  };
  const runtimeContext = () => {
    if (!registration.runtimeContext) throw new Error('Host runtime capabilities are unavailable.');
    return registration.runtimeContext();
  };
  const sendText = (chatId: string, text: string, options?: SendTextOptions) => {
    if (!registration.sendText) throw new Error('Host message delivery is unavailable.');
    return registration.sendText(chatId, text, options);
  };
  const deleteMessage = (messageId: string) => {
    if (!registration.deleteMessage) throw new Error('Host message deletion is unavailable.');
    return registration.deleteMessage(messageId);
  };
  const officialEventsAdopt = async (body: unknown): Promise<unknown> => {
    const parsed = eventOperatorActionSchemas.officialEventsAdopt.parse(body);
    return adoptEventLifecycle({
      context: commandContext(),
      activeTransport: {
        sendText: (chatId, text, options) => sendText(chatId, text, options)
      },
      adoption: parsed
    });
  };
  const officialEventsTerminate = async (body: unknown): Promise<unknown> => {
    const parsed = eventOperatorActionSchemas.officialEventsTerminate.parse(body);
    const context = commandContext();
    const runtime = requireOfficialCommandRuntime(context);
    const db = eventsDatabase(runtime.databases);
    const event = getEvent(db, parsed.eventId);
    if (!event || event.scopeId !== parsed.scopeId) {
      return {
        status: 'not_found',
        reason: `Unknown event ${parsed.eventId} in scope ${parsed.scopeId}.`
      };
    }
    return cancelEventLifecycle({
      context,
      runtime,
      db,
      event,
      actor: {
        wid: parsed.actorWid || OPERATOR_CONSOLE_ACTOR_WID,
        label: parsed.actorLabel || 'Operator Console'
      },
      calendarDisposition: parsed.calendarDisposition,
      deleteAnnouncementMessages: parsed.deleteAnnouncementMessages,
      deleteMessage: (messageId) => deleteMessage(messageId),
      ...(parsed.reason ? { reason: parsed.reason } : {})
    });
  };
  const officialEventsRetryCancellationCleanup = async (body: unknown): Promise<unknown> => {
    const parsed = eventOperatorActionSchemas.officialEventsRetryCancellationCleanup.parse(body);
    const context = commandContext();
    const runtime = requireOfficialCommandRuntime(context);
    const event = getEvent(eventsDatabase(runtime.databases), parsed.eventId);
    if (!event || event.scopeId !== parsed.scopeId || event.eventStatus !== 'cancelled') {
      return { status: 'not_available', reason: 'The cancelled event was not found.' };
    }
    const retryAt = new Date().toISOString();
    const rearmedArtifacts = retryEventArtifactDeletionCleanup(
      eventsDatabase(runtime.databases),
      event.id,
      retryAt
    );
    if (rearmedArtifacts === 0) {
      return { status: 'not_available', reason: 'No cancellation messages require another cleanup attempt.' };
    }
    await runtime.enqueuePluginJob({
      jobName: EVENTS_JOBS.cancellationCleanup,
      scopeId: event.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.groupWid ? { groupWid: event.groupWid } : {}),
      payload: { eventId: event.id },
      dedupeKey: `${EVENTS_JOBS.cancellationCleanup}:${event.id}:operator:${retryAt}`
    });
    return { status: 'queued', eventId: event.id, rearmedArtifacts };
  };
  const officialEventsCalendarHintReplay = async (body: unknown): Promise<unknown> => {
    return replayInitialEventCalendarHint({
      context: commandContext(),
      activeTransport: {
        sendText: (chatId, text, options) => sendText(chatId, text, options)
      },
      request: body
    });
  };
  const officialEventsResumeProvisioning = async (body: unknown): Promise<unknown> => {
    const parsed = eventOperatorActionSchemas.officialEventsResumeProvisioning.parse(body);
    return resumeEventProvisioningFromOperator({
      context: runtimeContext(),
      ...parsed,
      actorWid: parsed.actorWid || OPERATOR_CONSOLE_ACTOR_WID,
      actorLabel: parsed.actorLabel || 'Operator Console'
    });
  };
  const officialEventsRetryPreCreateProvisioning = async (body: unknown): Promise<unknown> => {
    const parsed = eventOperatorActionSchemas.officialEventsRetryPreCreateProvisioning.parse(body);
    return enqueueEventPreCreateProvisioningRecovery({
      context: runtimeContext(),
      scopeId: parsed.scopeId,
      eventId: parsed.eventId,
      expectedUpdatedAt: parsed.expectedUpdatedAt
    });
  };
  const officialEventsReplaceRejectedChild = async (body: unknown): Promise<unknown> => {
    const parsed = eventOperatorActionSchemas.officialEventsReplaceRejectedChild.parse(body);
    const context = runtimeContext();
    const db = eventsDatabase(context.databases);
    const event = getEvent(db, parsed.eventId);
    if (!event || event.scopeId !== parsed.scopeId) {
      return {
        status: 'not_found',
        reason: `Unknown event ${parsed.eventId} in scope ${parsed.scopeId}.`
      };
    }
    if (!context.communityGroupWidForScope) {
      throw new Error('Plugin runtime does not expose the managed community mapping.');
    }
    const parentCommunityJid = await context.communityGroupWidForScope(parsed.scopeId);
    if (!parentCommunityJid) {
      return {
        status: 'rejected',
        reason: `Scope ${parsed.scopeId} has no configured parent community.`,
        event
      };
    }
    return replaceRejectedEventChildFromOperator({
      context,
      ...parsed,
      actorWid: parsed.actorWid || OPERATOR_CONSOLE_ACTOR_WID,
      actorLabel: parsed.actorLabel || 'Operator Console',
      expectedParentCommunityJid: parentCommunityJid,
      probeRejectedChildLink: async () => {
        const current = getEvent(db, parsed.eventId);
        const creatorIdentityId = current?.actorIdentityId?.trim();
        if (!current || current.scopeId !== parsed.scopeId || !creatorIdentityId) {
          throw new Error(`Event ${parsed.eventId} has no authoritative creator identity.`);
        }
        const creatorReference = getEventRequiredCreatorReference(
          db,
          current.id,
          creatorIdentityId
        );
        if (!creatorReference) {
          throw new Error(`Event ${current.id} has no authoritative required-creator checkpoint.`);
        }
        if (!registration.probeCommunitySubgroupLink) throw new Error('Authoritative participant link probe is unavailable.');
        return registration.probeCommunitySubgroupLink({
          subgroupChatId: parsed.rejectedSubgroupChatId,
          parentCommunityJid,
          requiredParticipants: [{ identityId: creatorReference.identityId, participantWid: creatorReference.participantWid }]
        });
      }
    });
  };
  const officialEventsRecoverJobs = async (): Promise<unknown> => {
    const context = runtimeContext();
    const enqueued = await recoverEventJobs(context);
    return { enqueued };
  };
  const officialEventsPublishCalendar = (body: unknown) => publishEventCalendarFromOperator({ context: runtimeContext(), request: body });
  const handlers: Record<string, (body: unknown) => Promise<unknown>> = {
    'official.community-events.adopt': officialEventsAdopt,
    'official.community-events.terminate': officialEventsTerminate,
    'official.community-events.retryCancellationCleanup': officialEventsRetryCancellationCleanup,
    'official.community-events.calendarHintReplay': officialEventsCalendarHintReplay,
    'official.community-events.publishCalendar': officialEventsPublishCalendar,
    'official.community-events.resumeProvisioning': officialEventsResumeProvisioning,
    'official.community-events.retryPreCreateProvisioning': officialEventsRetryPreCreateProvisioning,
    'official.community-events.replaceRejectedChild': officialEventsReplaceRejectedChild,
    'official.community-events.recoverJobs': officialEventsRecoverJobs,
  };
  return eventOperatorActionDeclarations.map(declaration => {
    const suffix = declaration.actionId.slice('official.community-events.'.length);
    const schemaKey = ('officialEvents' + suffix[0]!.toUpperCase() + suffix.slice(1)) as keyof typeof eventOperatorActionSchemas;
    return { actionId: declaration.actionId,
      inputSchema: eventOperatorActionSchemas[schemaKey], outputSchema: z.record(z.unknown()),
      ...(declaration.scope === 'scope' ? { resolveScopeId: (body: unknown) => (body as { scopeId: string }).scopeId } : {}),
      handler: async (body, call) => { call.signal.throwIfAborted(); return handlers[declaration.actionId]!(body); }
    };
  });
}
