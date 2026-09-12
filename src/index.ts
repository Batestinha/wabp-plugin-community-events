import { eventsDatabase, getEventTimezoneForGroup } from './store';
import type { BotPlugin } from '../../../platform/pluginRuntime/types';
import { registerEventsCancellations, registerEventsCommands } from './commands';
import { createEventsHooks } from './hooks';
import { migrateEventIdentityData } from './identityMigration';
import { eventsManifest } from './manifest';
import { registerEventAlbumSourceServices } from './service';
import { registerEventWorkflowServices } from './workflowActions';

export const eventsPlugin: BotPlugin = {
  manifest: eventsManifest,
  resolveGroupTimezone({ databases, scopeId, groupWid }) {
    return getEventTimezoneForGroup(eventsDatabase(databases), scopeId, groupWid);
  },
  lifecycle: {
    migrateData: migrateEventIdentityData
  },
  registerCommands(context) {
    registerEventsCommands(context);
  },
  registerCancellations(context) {
    return registerEventsCancellations(context);
  },
  registerHooks(context) {
    return createEventsHooks(context, {
      recoverJobs: false,
      recoverCalendarPublications: true,
      recoverJobHandoffs: true
    });
  },
  registerServices(context) {
    return [...registerEventAlbumSourceServices(context), ...registerEventWorkflowServices(context)];
  }
};

export default eventsPlugin;
