import { defineControl } from '../../../platform/operatorConsole/controlCatalog/define';
import type { ControlDescriptor, ControlSchemaMetadata, ControlUiHint } from '../../../platform/operatorConsole/controlCatalog/types';
import { DEFAULT_EVENT_SUBGROUP_SUGGESTION_PRE_FLOW_NOTICE_TEMPLATE } from './config';

function control(
  path: string,
  label: string,
  description: string,
  order: number,
  schema: ControlSchemaMetadata,
  ui: ControlUiHint,
  configurable = true,
  safety: {
    dangerous?: boolean | undefined;
    confirmationMessage?: string | undefined;
  } = {}
): ControlDescriptor {
  const dangerous = safety.dangerous ?? false;
  return defineControl({
    id: `plugin.official.community-events.${path}`,
    label,
    description,
    plane: 'plugin-scope-config',
    domain: 'official-plugin-settings',
    section: 'Community Events',
    order,
    visibility: 'bot_admin',
    configurable,
    storage: { kind: 'plugin-scope-config', pluginId: 'official.community-events', path },
    schema,
    ui: { helpText: description, ...ui },
    restartRequirement: 'NO_RESTART',
    dangerous,
    ...(dangerous
      ? {
          confirmation: {
            required: true,
            message: safety.confirmationMessage ?? 'This changes Community Events automation.'
          }
        }
      : {}),
    sensitivity: { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update',
    relatedCommandIds: ['/event new', '/event edit', '/event status'],
    relatedActionIds: []
  });
}

const eventsPanelControl = defineControl({
  id: 'plugin.official.community-events.eventsPanel',
  label: 'Events',
  description: 'Published events recorded for this scope.',
  plane: 'plugin-scope-config',
  domain: 'official-plugin-settings',
  section: 'Community Events',
  order: 68,
  visibility: 'bot_admin',
  configurable: false,
  storage: { kind: 'internal', reason: 'Scoped events panel; data is loaded from the events plugin database, while manual termination and idempotent calendar-hint replay use audited runtime actions.' },
  schema: { type: 'object', properties: {} },
  ui: {
    widget: 'builder',
    builderId: 'official.community-events.events.v1',
    builderEndpoints: {
      state: '/api/v1/plugins/official.community-events/events/:scopeId',
      terminate: '/api/v1/plugins/official.community-events/events/:scopeId/:eventId/terminate',
      retryCancellationCleanup: '/api/v1/plugins/official.community-events/events/:scopeId/:eventId/cancellation-cleanup/retry',
      calendarHintReplay: '/api/v1/plugins/official.community-events/events/:scopeId/:eventId/calendar-hint/replay',
      calendarDisposition: '/api/v1/plugins/official.community-events/events/:scopeId/:eventId/calendar',
      calendarOwnership: '/api/v1/plugins/official.community-events/events/:scopeId/:eventId/calendar-ownership'
    },
    helpText: 'Published events recorded for this scope, with confirmed manual termination and idempotent initial calendar-hint replay for active event lifecycles.'
  },
  restartRequirement: 'NO_RESTART',
  dangerous: false,
  sensitivity: { sensitive: false, redact: 'none' },
  auditExemptReason: 'Panel rendering is read-only; manual termination and calendar-hint replay are audited by their runtime-action endpoints.',
  relatedCommandIds: ['/event list', '/event edit', '/event cancel'],
  relatedActionIds: []
});

export const eventsControls: ControlDescriptor[] = [
  control('enabled', 'Enabled', 'Enable guided event creation in this scope.', 10, { type: 'boolean' }, { widget: 'toggle' }),
  control('timezone', 'Timezone', 'IANA timezone used when combining event date and time answers.', 20, { type: 'string', format: 'timezone' }, { widget: 'select' }),
  control(
    'subgroupSuggestionConversion.policy',
    'Subgroup suggestion conversion',
    'Choose whether eligible WhatsApp community subgroup suggestions are ignored or automatically converted into fresh blank event-creation flows. Suggested group titles are discarded and never used as event prefill.',
    30,
    {
      type: 'enum',
      enum: [
        { value: 'off', label: 'Off' },
        { value: 'auto_convert', label: 'Automatically convert' }
      ]
    },
    {
      widget: 'segmented',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'auto_convert', label: 'Automatically convert' }
      ]
    },
    true,
    {
      dangerous: true,
      confirmationMessage: 'Automatically converting subgroup suggestions starts a fresh blank event-creation flow and then rejects the native WhatsApp suggestion. The suggested group title is discarded.'
    }
  ),
  control(
    'subgroupSuggestionConversion.preFlowNotice.enabled',
    'Suggestion refusal notice',
    'Send a private explanation to the suggestion creator immediately before the fresh event-creation flow prompt.',
    40,
    { type: 'boolean' },
    { widget: 'toggle' }
  ),
  control(
    'subgroupSuggestionConversion.preFlowNotice.template',
    'Suggestion refusal notice text',
    'Private text sent when an eligible native subgroup suggestion is detected, immediately before event setup. The exact suggestion is rejected only after initial flow delivery succeeds; suggested titles and other suggestion metadata are not available as template variables.',
    50,
    { type: 'string', required: true, max: 1000 },
    {
      widget: 'text',
      multiline: true,
      placeholder: DEFAULT_EVENT_SUBGROUP_SUGGESTION_PRE_FLOW_NOTICE_TEMPLATE
    }
  ),
  control('eventProfiles', 'Event profiles', 'Event profile definitions, canonical locations, calendars, and event forecast delivery managed by the event profile builder.', 60, { type: 'array', items: { type: 'object' } }, {
    widget: 'builder',
    builderId: 'official.community-events.event-profiles.v1',
    builderEndpoints: {
      options: '/api/v1/plugins/official.community-events/profiles/:scopeId/options',
      renameQuestion: '/api/v1/plugins/official.community-events/profiles/:scopeId/questions/rename',
      calendarState: '/api/v1/plugins/official.community-events/calendar/:scopeId/:calendarId',
      publish: '/api/v1/plugins/official.community-events/calendar/:scopeId/:calendarId/publish',
      rotateToken: '/api/v1/plugins/official.community-events/calendar/:scopeId/:calendarId/token'
    }
  }),
  control('calendars', 'Event calendars', 'Reusable calendar export resources managed by the event profile builder.', 65, { type: 'array', items: { type: 'object' } }, {
    widget: 'builder',
    builderId: 'official.community-events.event-profiles.v1',
    hideWhenBuilderMounted: true
  }),
  eventsPanelControl,
  control('adoption', 'Adopt existing event', 'Adopt an existing WhatsApp poll or event group into official.community-events lifecycle management.', 70, { type: 'object', properties: {} }, {
    widget: 'builder',
    builderId: 'official.community-events.adoption.v1',
    builderEndpoints: {
      options: '/api/v1/plugins/official.community-events/adoptions/:scopeId/options',
      adopt: '/api/v1/plugins/official.community-events/adoptions'
    },
    hideWhenBuilderMounted: true
  }, false),
  control('cleanup.retryDelaysMinutes', 'Cleanup retry delays', 'Retry delays, in minutes, for subgroup transcript capture or deletion failures.', 80, { type: 'array', items: { type: 'number' } }, { widget: 'number' }),
  control('cleanup.lastFailureMessage', 'Cleanup failure', 'Most recent subgroup transcript capture or deletion failure.', 90, { type: 'string' }, { widget: 'text' }, false),
  control('cleanup.lastFailureAt', 'Cleanup failure time', 'ISO timestamp for the most recent subgroup cleanup failure.', 100, { type: 'string' }, { widget: 'text' }, false)
];
