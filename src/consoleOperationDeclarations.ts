import type { PluginConsoleOperationDeclaration } from '@wabs/plugin-sdk/console-operations';

export const eventConsoleOperationDeclarations: PluginConsoleOperationDeclaration[] = [
  { operationId: 'official.community-events.eventsCalendarSubscriptionInfo', access: 'read', authorization: 'operator', description: 'events Calendar Subscription Info' },
  { operationId: 'official.community-events.publishEventsCalendar', access: 'mutation', authorization: 'operator', description: 'publish Events Calendar' },
  { operationId: 'official.community-events.rotateEventsCalendarSubscriptionToken', access: 'mutation', authorization: 'operator', description: 'rotate Events Calendar Subscription Token' },
  { operationId: 'official.community-events.officialEventsProfileOptions', access: 'read', authorization: 'operator', description: 'official Events Profile Options' },
  { operationId: 'official.community-events.renameOfficialEventProfileQuestion', access: 'mutation', authorization: 'operator', description: 'rename Official Event Profile Question' },
  { operationId: 'official.community-events.officialEventsForScope', access: 'read', authorization: 'operator', description: 'official Events For Scope' },
  { operationId: 'official.community-events.terminateOfficialEvent', access: 'mutation', authorization: 'operator', description: 'terminate Official Event' },
  { operationId: 'official.community-events.retryOfficialEventCancellationCleanup', access: 'mutation', authorization: 'operator', description: 'retry Official Event Cancellation Cleanup' },
  { operationId: 'official.community-events.replayOfficialEventCalendarHint', access: 'mutation', authorization: 'operator', description: 'replay Official Event Calendar Hint' },
  { operationId: 'official.community-events.setOfficialEventCalendarDisposition', access: 'mutation', authorization: 'operator', description: 'set Official Event Calendar Disposition' },
  { operationId: 'official.community-events.assignOfficialEventCalendarOwnership', access: 'mutation', authorization: 'operator', description: 'assign Official Event Calendar Ownership' },
  { operationId: 'official.community-events.officialEventsAdoptionOptions', access: 'read', authorization: 'operator', description: 'official Events Adoption Options' },
  { operationId: 'official.community-events.adoptOfficialEvent', access: 'mutation', authorization: 'operator', description: 'adopt Official Event' },
  { operationId: 'official.community-events.eventsCalendarSubscriptionDocument', access: 'read', authorization: 'resource-token', description: 'events Calendar Subscription Document' }
];
