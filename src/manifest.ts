import type { PluginManifest } from '../../../platform/pluginRuntime/manifest';
import { eventsConfigSchema } from './config';
import { eventsMessages } from './messages';

export const EVENTS_PLUGIN_ID = 'official.community-events';
export const EVENTS_DATABASE = 'events';

export const EVENTS_JOBS = {
  close: 'event.close',
  cleanup: 'event.cleanup'
} as const;

export const EVENTS_PERMISSIONS = {
  configure: 'events.configure',
  manage: 'events.manage',
  createClimbing: 'events.create.climbing'
} as const;

export const eventsDatabases = [{
  name: EVENTS_DATABASE,
  engine: 'sqlite' as const,
  scope: 'botProfile' as const,
  migrations: 'migrations/events'
}];

export const eventsManifest: PluginManifest = {
  pluginId: EVENTS_PLUGIN_ID,
  kind: 'managed_group',
  version: '0.1.0',
  coreApiRange: '>=0.2.0',
  messageNamespace: 'official.community-events',
  descriptionKey: 'official.community-events.description',
  defaultMessages: eventsMessages,
  commands: [
    '/event',
    '/event status',
    '/event cancel'
  ],
  eventSubscriptions: ['poll.vote', 'plugin.job', 'group.decommissioned'],
  requiredPermissions: [
    EVENTS_PERMISSIONS.configure,
    EVENTS_PERMISSIONS.manage,
    EVENTS_PERMISSIONS.createClimbing
  ],
  requiredBotCapabilities: [],
  configSchema: eventsConfigSchema,
  dangerousActions: [],
  backgroundJobs: [
    EVENTS_JOBS.close,
    EVENTS_JOBS.cleanup
  ],
  dependencies: [
    { pluginId: 'official.doas', versionRange: '>=0.1.0' },
    { pluginId: 'official.community-subgroups', versionRange: '>=0.1.0' }
  ],
  databases: eventsDatabases,
  dataVersion: '1',
  assistant: {
    summary: 'Guided event creation with scoped polls, attendee subgroups, and calendar export.',
    useCases: [
      'Create event polls from configured profiles.',
      'Cancel active event lifecycles by creator or event manager.',
      'Close polls before the event, gather attendees, and create event subgroups.',
      'Export one calendar file per scope.'
    ],
    prerequisites: [
      'official.doas must be enabled for the target scope.',
      'official.community-subgroups must be installed so event subgroups use the shared creation policy.',
      'The bot must be an admin of the announcement and community groups.',
      'The caller needs the configured profile-specific events.create.* permission to create events.',
      'The event creator or an events.manage actor can cancel active events.'
    ],
    workflows: [
      {
        intent: 'event_create',
        description: 'Start a guided event creation flow.',
        commands: ['/event']
      },
      {
        intent: 'event_status',
        description: 'Inspect event plugin status for the current scope.',
        commands: ['/event status']
      },
      {
        intent: 'event_cancel',
        description: 'Cancel a scheduled or open event lifecycle.',
        commands: ['/event cancel']
      }
    ]
  }
};
