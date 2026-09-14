import type { PluginRuntimeContext } from './runtime';
import { eventsDatabase } from './store';
import { parseEventsConfig, localizeDefaultEventProfiles } from './config';
import { eventRawAnswers } from './template';
/** Non-destructive backfill: original display answers remain intact and ambiguous choices stay unavailable. */
export async function backfillEventTemplateValues(context: PluginRuntimeContext): Promise<void> {
  const db = eventsDatabase(context.databases);
  const rows = db.all<{ id: string; scope_id: string; profile_id: string; answers_json: string }>(
    'SELECT id, scope_id, profile_id, answers_json FROM event_records WHERE raw_answers_json IS NULL');
  for (const scopeId of new Set(rows.map(row => row.scope_id))) {
    const config = parseEventsConfig(await context.configFor(scopeId));
    const t = await context.i18n.translatorForScope(scopeId);
    const profiles = localizeDefaultEventProfiles(config.eventProfiles, t);
    db.transaction(() => {
      for (const row of rows.filter(item => item.scope_id === scopeId)) {
        const profile = profiles.find(item => item.id === row.profile_id);
        if (!profile) continue;
        const raw = eventRawAnswers(profile, JSON.parse(row.answers_json));
        db.run('UPDATE event_records SET raw_answers_json = ? WHERE id = ? AND answers_json = ? AND raw_answers_json IS NULL', JSON.stringify(raw), row.id, row.answers_json);
      }
    });
  }
}
