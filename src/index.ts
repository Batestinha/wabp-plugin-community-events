import type { BotPlugin } from '../../../platform/pluginRuntime/types';
import { registerEventsCancellations, registerEventsCommands } from './commands';
import { createEventsHooks } from './hooks';
import { eventsManifest } from './manifest';

export const eventsPlugin: BotPlugin = {
  manifest: eventsManifest,
  registerCommands(context) {
    registerEventsCommands(context);
  },
  registerCancellations(context) {
    return registerEventsCancellations(context);
  },
  registerHooks(context) {
    return createEventsHooks(context);
  }
};

export default eventsPlugin;
