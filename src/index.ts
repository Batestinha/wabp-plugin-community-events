import type { BotPlugin } from '../../../platform/pluginRuntime/types';
import { registerEventsCommands } from './commands';
import { createEventsHooks } from './hooks';
import { eventsManifest } from './manifest';

export const eventsPlugin: BotPlugin = {
  manifest: eventsManifest,
  registerCommands(context) {
    registerEventsCommands(context);
  },
  registerHooks(context) {
    return createEventsHooks(context);
  }
};

export default eventsPlugin;
