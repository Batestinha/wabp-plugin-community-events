import type { FlowDefinition } from '@wabs/plugin-sdk/flow-types';
import type { FlowSessionSnapshot, FlowStartOrigin } from '@wabs/plugin-sdk/flow-engine';
import type { ConfirmedEventPublicationInput, EventFlowCompletionContext } from './commands';
import type { EventFlowAnswers } from './flow';
import type { OfficialPluginCommandRuntime, TranslateFn } from './runtime';
import { eventAnswersInTimezone } from './locationTimezone';
import { materializeEventLifecycle } from './materialize';
import { formatEventDateTime } from './datetime';
import { EVENTS_PLUGIN_ID } from './manifest';

const PREFIX = 'official.community-events.publish.';
const STEP = 'event-poll-phase';
const RECIPE = '__eventPublication';
type PublicationRecipe = Omit<ConfirmedEventPublicationInput, 'context' | 'runtime' | 'activeTransport' | 't' | 'answers'> & {
  answers: Omit<EventFlowAnswers, 'startsAt' | 'endsAt'> & { startsAt: string; endsAt: string };
  title: string;
  closeAt: string;
};
type Publish = (input: ConfirmedEventPublicationInput) => Promise<void>;
const registrations = new WeakSet<object>();
const completionRegistrations = new WeakMap<object, Set<string>>();

function recipeFor(session: FlowSessionSnapshot): PublicationRecipe {
  const recipe = session.state.data[RECIPE] as PublicationRecipe | undefined;
  if (!recipe || session.flowType !== `${PREFIX}${recipe.draft.flowSessionId}`
    || session.identityId !== recipe.draft.actorIdentityId || session.scopeId !== recipe.draft.scopeId
    || !Number.isFinite(Date.parse(recipe.answers.startsAt)) || !Number.isFinite(Date.parse(recipe.answers.endsAt))) {
    throw new Error('Event publication session does not match its durable creation recipe.');
  }
  return recipe;
}

function definitionFor(recipe: PublicationRecipe, t: TranslateFn): FlowDefinition {
  const timezone = recipe.eventLocation.timezone;
  return {
    flowType: `${PREFIX}${recipe.draft.flowSessionId}`,
    navigationControls: true,
    t, initialStepId: STEP, context: 'either', timeoutMinutes: 30, completionReply: false,
    steps: {
      [STEP]: {
        id: STEP, kind: 'choice',
        prompt: t('official.community-events.flow.publicationChoice', {
          title: recipe.title,
          startsAt: formatEventDateTime(new Date(recipe.answers.startsAt), timezone, recipe.draft.locale),
          endsAt: formatEventDateTime(new Date(recipe.answers.endsAt), timezone, recipe.draft.locale),
          closeAt: formatEventDateTime(new Date(recipe.closeAt), timezone, recipe.draft.locale)
        }),
        options: [
          { label: t('official.community-events.flow.pollPhase.poll'), value: 'poll' },
          { label: t('official.community-events.flow.pollPhase.unplanned'), value: 'unplanned' }
        ],
        minSelections: 1, maxSelections: 1
      }
    }
  };
}

export function registerFinalEventCreationFlow(
  context: EventFlowCompletionContext, runtime: OfficialPluginCommandRuntime, publish: Publish
): void {
  const engine = context.flowEngine;
  if (!engine || registrations.has(engine)) return;
  engine.registerDefinitionResolver({
    ownerId: EVENTS_PLUGIN_ID, flowTypePrefix: PREFIX,
    async resolve(session) {
      const recipe = recipeFor(session);
      const t = await context.i18n.translatorForIdentity(recipe.draft.actorIdentityId, recipe.draft.scopeId);
      const definition = definitionFor(recipe, t);
      registerCompletion(definition, context, runtime, publish);
      return definition;
    }
  });
  registrations.add(engine);
}

function registerCompletion(definition: FlowDefinition, context: EventFlowCompletionContext, runtime: OfficialPluginCommandRuntime, publish: Publish): void {
  const engine = context.flowEngine!;
  const registered = completionRegistrations.get(engine) ?? new Set<string>();
  if (registered.has(definition.flowType)) return;
  registered.add(definition.flowType);
  completionRegistrations.set(engine, registered);
  engine.registerPromptHandler(`flow.${definition.flowType}.${STEP}`, async (lock, activeTransport) => {
    if (!lock.flowSessionId) return false;
    const session = await engine.getSessionSnapshot(lock.flowSessionId);
    if (!session || session.flowType !== definition.flowType || session.status !== 'COMPLETED') return false;
    const recipe = recipeFor(session);
    if (lock.voterIdentityId !== recipe.draft.actorIdentityId) return false;
    const selected = session.state.data[STEP];
    const pollPhase = Array.isArray(selected) ? selected[0] : undefined;
    if (pollPhase !== 'poll' && pollPhase !== 'unplanned') return false;
    const t = await context.i18n.translatorForIdentity(recipe.draft.actorIdentityId, recipe.draft.scopeId);
    await publish({ ...recipe, context, runtime, activeTransport, t, responseChatId: session.chatId,
      answers: { ...recipe.answers, startsAt: new Date(recipe.answers.startsAt), endsAt: new Date(recipe.answers.endsAt), pollPhase } });
    await engine.acknowledgePromptLock(lock.flowPromptId);
    return true;
  }, { recoverLocked: true });
}

/** Called only after the creator confirms the details and the final location is resolved. */
export async function beginFinalEventCreation(input: ConfirmedEventPublicationInput, publish: Publish): Promise<void> {
  input = { ...input, answers: eventAnswersInTimezone(input.answers, input.eventLocation.timezone) };
  const materialized = materializeEventLifecycle({ profile: input.profile, answers: input.answers,
    timezone: input.eventLocation.timezone, locale: input.draft.locale,
    creatorDisplayName: input.draft.actorLabel || input.draft.actorWid, eventLocation: input.eventLocation });
  // Old flows already collected this decision. Keep their prompt mapping and recorded choice.
  if (input.draft.schemaVersion !== 2 || materialized.closeAt.getTime() <= Date.now()) {
    await publish(input);
    return;
  }
  registerFinalEventCreationFlow(input.context, input.runtime, publish);
  const recipe: PublicationRecipe = {
    responseChatId: input.responseChatId, draft: input.draft, profile: input.profile,
    announcementGroupWid: input.announcementGroupWid, eventLocation: input.eventLocation,
    answers: { ...input.answers, startsAt: input.answers.startsAt.toISOString(), endsAt: input.answers.endsAt.toISOString() },
    title: materialized.groupTitle, closeAt: materialized.closeAt.toISOString()
  };
  const definition = definitionFor(recipe, input.t);
  registerCompletion(definition, input.context, input.runtime, publish);
  const origin: FlowStartOrigin = { chatId: input.responseChatId, context: input.responseChatId.endsWith('@g.us') ? 'group' : 'private' };
  await input.context.flowEngine!.startFlowForIdentity({
    definition, actorIdentityId: input.draft.actorIdentityId, scopeId: input.draft.scopeId, origin,
    externalIdempotencyKey: `community-events:publication:${input.draft.flowSessionId}`,
    initialData: { [RECIPE]: recipe },
    ...(input.draft.privateDeliveryFallback ? { privateDeliveryFallback: input.draft.privateDeliveryFallback } : {})
  });
}
