import type { PluginRuntimeContext } from './runtime';
import { appendEventLog, eventsDatabase, type StoredEventRecord } from './store';

export type EventPreCreateTerminalNoticeKind = 'attempts_exhausted' | 'cleanup_expired';

export async function notifyEventCreatorPreCreateTerminal(
  context: PluginRuntimeContext,
  event: StoredEventRecord,
  kind: EventPreCreateTerminalNoticeKind
): Promise<boolean> {
  const db = eventsDatabase(context.databases);
  const alreadySent = db.get<{ sent: number }>(
    `SELECT 1 AS sent
       FROM event_logs
      WHERE event_id = ?
        AND action = 'events.provisioning.precreate_terminal_notice_sent'
      LIMIT 1`,
    event.id
  );
  if (alreadySent) {
    return false;
  }
  const idempotencyKey = `community-events:precreate-terminal:${event.id}`;
  try {
    if (!event.actorIdentityId?.trim()) {
      throw new Error(`Event ${event.id} has no authoritative creator identity.`);
    }
    if (!context.resolveStableIdentityById || !context.sendText) {
      throw new Error('Plugin runtime does not expose authoritative creator notice delivery.');
    }
    const [creatorAddress, t] = await Promise.all([
      context.resolveStableIdentityById(event.actorIdentityId),
      context.i18n.translatorForIdentity(event.actorIdentityId, event.scopeId)
    ]);
    const messageKey = kind === 'attempts_exhausted'
      ? 'official.community-events.provisioningTerminal.attemptsExhausted'
      : 'official.community-events.provisioningTerminal.cleanupExpired';
    await context.sendText(
      creatorAddress.deliveryChatId,
      t(messageKey, {
        title: event.groupTitle,
        eventId: event.id
      }),
      { idempotencyKey }
    );
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.precreate_terminal_notice_sent',
      metadata: {
        kind,
        creatorIdentityId: event.actorIdentityId,
        creatorChatId: creatorAddress.deliveryChatId,
        idempotencyKey
      }
    });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.precreate_terminal_notice_failed',
      metadata: { kind, idempotencyKey, reason }
    });
    context.logger.warn(
      { error, eventId: event.id, kind },
      'Unable to deliver event pre-create terminal notice'
    );
    return false;
  }
}
