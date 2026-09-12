import type { PluginManifest } from '../../../../packages/plugin-sdk/src/manifest';
import { POLL_HISTORY_OWNED_DATA_RESOURCE } from '../../../../packages/plugin-sdk/src/owned-data';
import { eventsConfigSchema } from './config';
import { eventsMessages } from './messages';
import { EVENT_WORKFLOW_SERVICE_ID, eventWorkflowActions } from './workflowActionApi';
import {
  EVENT_ALBUM_SOURCE_LIST_METHOD,
  EVENT_ALBUM_SOURCE_RESOLVE_METHOD,
  EVENT_ALBUM_SOURCE_SERVICE_ID,
  EVENT_SUBGROUP_OWNERSHIP_RESOLVE_METHOD,
  EVENT_SUBGROUP_OWNERSHIP_SERVICE_ID
} from './serviceApi';

export const EVENTS_PLUGIN_ID = 'official.community-events';
export const EVENTS_DATABASE = 'events';

export const EVENTS_JOBS = {
  close: 'event.close',
  complete: 'event.complete',
  provisioningRecovery: 'event.provisioningRecovery',
  unplannedFinalization: 'event.unplannedFinalization',
  cleanup: 'event.cleanup',
  cancellationCleanup: 'event.cancellationCleanup',
  announcementDelivery: 'event.announcementDelivery',
  editRepair: 'event.editRepair',
  pollReplacement: 'event.pollReplacement',
  attendanceLifecycle: 'event.attendanceLifecycle',
  weatherForecast: 'event.weatherForecast',
  startTimeAgreement: 'event.startTimeAgreement',
  questionKeyRenameRecovery: 'event.questionKeyRenameRecovery',
  suggestionReconcile: 'event.suggestionReconcile'
} as const;

export const EVENTS_PERMISSIONS = {
  configure: 'events.configure',
  manage: 'events.manage',
  createClimbing: 'events.create.climbing'
} as const;

export const eventsDatabases = [{
  name: EVENTS_DATABASE,
  engine: 'sqlite' as const,
  scope: 'account' as const,
  migrations: 'migrations/events'
}];

export const eventsManifest: PluginManifest = {
  pluginId: EVENTS_PLUGIN_ID,
  kind: 'managed_group',
  version: '0.15.0',
  coreApiRange: '^0.3.0',
  messageNamespace: 'official.community-events',
  descriptionKey: 'official.community-events.description',
  defaultMessages: eventsMessages,
  commands: [
    '/event',
    '/event new',
    '/event edit',
    '/event list',
    '/event poll',
    '/event status',
    '/event cancel'
  ],
  help: {
    featureId: 'events',
    titleKey: 'official.community-events.help.feature.title',
    summaryKey: 'official.community-events.help.feature.summary',
    order: 20,
    aliases: ['event', 'calendar', 'activities'],
    topics: [
      {
        topicId: 'overview-events',
        titleKey: 'official.community-events.help.feature.title',
        summaryKey: 'official.community-events.help.feature.summary',
        order: 5,
        commands: ['/event'],
        exampleKeys: ['official.community-events.help.overview.example'],
        keywords: ['event', 'help', 'usage']
      },
      {
        topicId: 'create-events',
        titleKey: 'official.community-events.help.create.title',
        summaryKey: 'official.community-events.help.create.summary',
        order: 10,
        commands: ['/event new'],
        instructionKeys: ['official.community-events.help.create.instruction'],
        exampleKeys: ['official.community-events.help.create.example'],
        keywords: ['create', 'poll', 'activity', 'calendar']
      },
      {
        topicId: 'edit-events',
        titleKey: 'official.community-events.help.edit.title',
        summaryKey: 'official.community-events.help.edit.summary',
        order: 20,
        commands: ['/event edit'],
        instructionKeys: ['official.community-events.help.edit.instruction'],
        exampleKeys: ['official.community-events.help.edit.example'],
        keywords: ['edit', 'update', 'rename', 'date']
      },
      {
        topicId: 'list-events',
        titleKey: 'official.community-events.help.list.title',
        summaryKey: 'official.community-events.help.list.summary',
        order: 30,
        commands: ['/event list'],
        instructionKeys: ['official.community-events.help.list.instruction'],
        exampleKeys: ['official.community-events.help.list.example'],
        keywords: ['list', 'future', 'upcoming']
      },
      {
        topicId: 'inspect-events',
        titleKey: 'official.community-events.help.inspect.title',
        summaryKey: 'official.community-events.help.inspect.summary',
        order: 40,
        commands: ['/event status'],
        exampleKeys: ['official.community-events.help.status.example'],
        keywords: ['status', 'configuration']
      },
      {
        topicId: 'close-event-polls',
        titleKey: 'official.community-events.help.pollClose.title',
        summaryKey: 'official.community-events.help.pollClose',
        order: 45,
        commands: ['/event poll'],
        instructionKeys: ['official.community-events.help.pollClose.instruction'],
        exampleKeys: ['official.community-events.help.pollClose.example'],
        keywords: ['poll', 'close', 'early', 'creator']
      },
      {
        topicId: 'cancel-events',
        titleKey: 'official.community-events.help.cancel.title',
        summaryKey: 'official.community-events.help.cancel.summary',
        order: 50,
        commands: ['/event cancel'],
        instructionKeys: ['official.community-events.help.cancel.instruction'],
        exampleKeys: ['official.community-events.help.cancel.example'],
        keywords: ['cancel', 'remove', 'stop']
      }
    ]
  },
  eventSubscriptions: ['message', 'participant.change', 'poll.vote', 'plugin.job', 'group.dismantled'],
  services: [
    {
      serviceId: EVENT_WORKFLOW_SERVICE_ID,
      description: 'Prepare, apply and inspect requester-authorized event changes through the event lifecycle.',
      methods: ['edit', 'cancel'].flatMap((action) => [
        { name: `${action}Describe`, access: 'read' as const }, { name: `${action}Prepare`, access: 'read' as const },
        { name: `${action}Execute`, access: 'mutation' as const, timeoutMs: 120000 }, { name: `${action}Inspect`, access: 'read' as const }
      ])
    },
    {
      serviceId: EVENT_ALBUM_SOURCE_SERVICE_ID,
      description: 'List and resolve scoped community events as immutable album metadata sources.',
      methods: [
        { name: EVENT_ALBUM_SOURCE_LIST_METHOD, access: 'read' },
        { name: EVENT_ALBUM_SOURCE_RESOLVE_METHOD, access: 'read' }
      ]
    },
    {
      serviceId: EVENT_SUBGROUP_OWNERSHIP_SERVICE_ID,
      description: 'Resolve whether a managed subgroup is owned by an event lifecycle.',
      methods: [{
        name: EVENT_SUBGROUP_OWNERSHIP_RESOLVE_METHOD,
        access: 'read',
        availability: 'installed'
      }]
    }
  ],
  requiredPermissions: [
    EVENTS_PERMISSIONS.configure,
    EVENTS_PERMISSIONS.manage,
    EVENTS_PERMISSIONS.createClimbing
  ],
  requiredBotCapabilities: [],
  workflowActions: eventWorkflowActions,
  configSchema: eventsConfigSchema,
  dangerousActions: ['message.delete'],
  backgroundJobs: [
    EVENTS_JOBS.close,
    EVENTS_JOBS.complete,
    EVENTS_JOBS.provisioningRecovery,
    EVENTS_JOBS.unplannedFinalization,
    EVENTS_JOBS.cleanup,
    EVENTS_JOBS.cancellationCleanup,
    EVENTS_JOBS.announcementDelivery,
    EVENTS_JOBS.editRepair,
    EVENTS_JOBS.pollReplacement,
    EVENTS_JOBS.attendanceLifecycle,
    EVENTS_JOBS.weatherForecast,
    EVENTS_JOBS.startTimeAgreement,
    EVENTS_JOBS.questionKeyRenameRecovery,
    EVENTS_JOBS.suggestionReconcile
  ],
  cancellation: {
    workflows: [
      {
        id: 'event-create',
        description: 'Guided event setup before an event poll is published.',
        mode: 'core-flow',
        scope: 'actor-chat',
        commands: ['/event new'],
        cancellableStates: ['active'],
        terminalStates: ['completed', 'cancelled', 'expired'],
        effects: ['discard-event-draft']
      },
      {
        id: 'event-edit',
        description: 'Guided structured update of an existing event lifecycle.',
        mode: 'core-flow',
        scope: 'actor-chat',
        commands: ['/event edit'],
        cancellableStates: ['active'],
        terminalStates: ['completed', 'cancelled', 'expired'],
        effects: ['discard-event-update-draft']
      },
      {
        id: 'event-cancel-confirmation',
        description: 'Guided confirmation before cancelling a published event lifecycle.',
        mode: 'core-flow',
        scope: 'actor-chat',
        commands: ['/event cancel'],
        cancellableStates: ['active'],
        terminalStates: ['completed', 'cancelled', 'expired'],
        effects: ['discard-event-cancellation-draft']
      },
      {
        id: 'event-location-selection',
        description: 'Pending event location confirmation after event setup and before publication.',
        mode: 'plugin-handler',
        scope: 'actor-chat',
        commands: ['/event new', '/event edit'],
        cancellableStates: ['active'],
        terminalStates: ['completed', 'cancelled', 'expired'],
        effects: ['discard-pending-location-selection']
      },
      {
        id: 'event-edit-selection',
        description: 'Pending interactive event selection before an event update or creator poll close.',
        mode: 'plugin-handler',
        scope: 'actor-chat',
        commands: ['/event edit', '/event poll'],
        cancellableStates: ['active'],
        terminalStates: ['completed', 'cancelled', 'expired'],
        effects: ['discard-pending-event-edit-selection']
      },
      {
        id: 'published-event-lifecycle',
        description: 'Published event lifecycles must be cancelled with the explicit event cancellation workflow.',
        mode: 'not-cancellable',
        scope: 'scope',
        commands: ['/event cancel'],
        notCancellableReason: 'Published event cancellation can affect polls, calendars, and managed event groups, so it requires explicit event selection and confirmation.'
      }
    ]
  },
  dependencies: [
    { pluginId: 'official.doas', versionRange: '>=0.3.0' },
    { pluginId: 'official.community-subgroups', versionRange: '>=0.1.0' },
    { pluginId: 'official.geocoder', versionRange: '^0.2.0' },
    { pluginId: 'official.poll-assistant', versionRange: '>=0.3.0' },
    { pluginId: 'official.weather', versionRange: '>=0.4.0', optional: true },
    { pluginId: 'official.workspace-connector', versionRange: '>=0.1.0', optional: true }
  ],
  ownedData: [{ resource: POLL_HISTORY_OWNED_DATA_RESOURCE }],
  scopeClock: { timezoneConfigPaths: ['timezone'], providesGroupTimezones: true },
  databases: eventsDatabases,
  dataVersion: '18',
  assistant: {
    summary: 'Guided event creation with scoped polls, unplanned attendee subgroups, and calendar export.',
    useCases: [
      'Create day-trip or multi-day event polls from configured profiles, or create event subgroups directly when the creator skips the poll or its close time has already passed.',
      'Cancel active event lifecycles by creator or event manager.',
      'Close polls before the event, gather attendees, and create event subgroups.',
      'Export one calendar file per scope.',
      'When weather is enabled, send forecasts 15, 12, 7, 2 and 1 days before the event, on the event day and daily during multi-day events. Send immediately for groups created within the forecast window; each update covers the remaining event days available.',
      'For community scopes, treat the community and its child groups as one logical event target; do not ask the user to choose between child groups just because they belong to the same community.'
    ],
    prerequisites: [
      'official.doas must be enabled for the target scope.',
      'official.community-subgroups must be installed so event subgroups use the shared creation policy.',
      'official.geocoder must be enabled for event profiles whose location comes from a question.',
      'official.poll-assistant 0.3.0 or newer must be enabled in the target scope for new and replacement attendance polls.',
      'The bot must be an admin of the announcement and community groups.',
      'The caller needs the configured profile-specific events.create.* permission to create events.',
      'The event creator or an events.manage actor can cancel active events.',
      'Event-day weather forecasts require official.weather to be installed, enabled, and configured for the same scope. The weather plugin metric controls determine which atmospheric and marine values are sent.'
    ],
    workflows: [
      {
        intent: 'event_create',
        description: 'Start a guided event creation flow.',
        commands: ['/event new']
      },
      {
        intent: 'event_edit',
        description: 'Update an event by ID, title, or current event subgroup.',
        commands: ['/event edit']
      },
      {
        intent: 'event_list',
        description: 'List future active events in chronological order.',
        commands: ['/event list']
      },
      {
        intent: 'event_status',
        description: 'Inspect event plugin status for the current scope.',
        commands: ['/event status']
      },
      {
        intent: 'event_cancel',
        description: 'Cancel an active event lifecycle.',
        commands: ['/event cancel']
      }
    ]
  }
};
