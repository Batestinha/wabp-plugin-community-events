import { backfillEventTemplateValues } from './templateMigration';
import { registerEventsExternalActions } from './externalActions';
import { registerEventsConsoleOperations } from './consoleOperations';
import { eventsDatabase, getEventTimezoneForGroup } from './store';
import type { BotPlugin } from './runtime';
import { registerEventsCancellations, registerEventsCommands } from './commands';
import { createEventsHooks, recoverEventJobs } from './hooks';
import { migrateEventIdentityData } from './identityMigration';
import { eventsManifest } from './manifest';
import { registerEventAlbumSourceServices } from './service';
import { registerEventWorkflowServices } from './workflowActions';

export const eventsPlugin: BotPlugin = {
  manifest: eventsManifest,
  registerConsoleOperations: registerEventsConsoleOperations,
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
    const hooks = createEventsHooks(context, {
      recoverJobs: false,
      recoverCalendarPublications: true,
      recoverJobHandoffs: true
    });
    return { ...hooks, async onRuntimeReady(event) {
      await backfillEventTemplateValues(context);
      await recoverEventJobs(context, { startupBeforeWorker: event.startupBeforeWorker });
    } };
  },
  registerExternalActions: registerEventsExternalActions,
  registerServices(context) {
    return [...registerEventAlbumSourceServices(context), ...registerEventWorkflowServices(context)];
  }
};

export default eventsPlugin;
