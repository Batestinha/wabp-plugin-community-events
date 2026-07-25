import { defineControl } from '../../../platform/operatorConsole/controlCatalog/define';
import type { ControlDescriptor, ControlSchemaMetadata, ControlUiHint } from '../../../platform/operatorConsole/controlCatalog/types';

function control(
  path: string,
  label: string,
  description: string,
  order: number,
  schema: ControlSchemaMetadata,
  ui: ControlUiHint,
  configurable = true
): ControlDescriptor {
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
    dangerous: false,
    sensitivity: { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update',
    relatedCommandIds: ['/event'],
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
  storage: { kind: 'internal', reason: 'Read-only scoped events panel; data is loaded from the events plugin database.' },
  schema: { type: 'object', properties: {} },
  ui: {
    widget: 'builder',
    builderId: 'official.community-events.events.v1',
    builderEndpoints: {
      state: '/api/v1/plugins/official.community-events/events/:scopeId'
    },
    helpText: 'Published events recorded for this scope.'
  },
  restartRequirement: 'NO_RESTART',
  dangerous: false,
  sensitivity: { sensitive: false, redact: 'none' },
  auditExemptReason: 'Read-only scoped events panel.',
  relatedCommandIds: ['/event'],
  relatedActionIds: []
});

export const eventsControls: ControlDescriptor[] = [
  control('enabled', 'Enabled', 'Enable guided event creation in this scope.', 10, { type: 'boolean' }, { widget: 'toggle' }),
  control('timezone', 'Timezone', 'IANA timezone used when combining event date and time answers.', 20, { type: 'string', format: 'timezone' }, { widget: 'select' }),
  control('eventProfiles', 'Event profiles', 'Event profile definitions managed by the event profile builder.', 60, { type: 'array', items: { type: 'object' } }, {
    widget: 'builder',
    builderId: 'official.community-events.event-profiles.v1',
    builderEndpoints: {
      options: '/api/v1/plugins/official.community-events/profiles/:scopeId/options',
      calendarState: '/api/v1/plugins/official.community-events/calendar/:scopeId/:calendarId',
      setFunnel: '/api/v1/plugins/official.community-events/calendar/:scopeId/:calendarId/funnel',
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
