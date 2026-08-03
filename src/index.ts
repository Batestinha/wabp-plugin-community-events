import type { BotPlugin } from '../../../platform/pluginRuntime/types';
import { registerEventsCancellations, registerEventsCommands } from './commands';
import { createEventsHooks } from './hooks';
import { eventsManifest } from './manifest';
import { registerEventAlbumSourceServices } from './service';

export const eventsPlugin: BotPlugin = {
  manifest: eventsManifest,
  registerCommands(context) {
    registerEventsCommands(context);
  },
  registerCancellations(context) {
    return registerEventsCancellations(context);
  },
  registerHooks(context) {
    return createEventsHooks(context, { recoverJobs: false });
  },
  registerServices(context) {
    return registerEventAlbumSourceServices(context);
  }
};

export default eventsPlugin;
