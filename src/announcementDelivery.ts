import type { PluginDatabase } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import {
  claimEventAnnouncementDelivery,
  completeEventAnnouncementDelivery,
  getEventAnnouncementDeliveryClaim,
  listEventAnnouncementMessages,
  markEventAnnouncementDeliveryUncertain,
  type EventAnnouncementDeliveryKind
} from './store';

export type ClaimedEventAnnouncementResult =
  | { status: 'sent'; messageId: string }
  | { status: 'already_sent' }
  | { status: 'already_claimed' };

export function persistedEventAnnouncementDisposition(
  db: PluginDatabase,
  eventId: string,
  kind: EventAnnouncementDeliveryKind
): 'already_sent' | 'already_claimed' | undefined {
  if (listEventAnnouncementMessages(db, eventId, { includeDeleted: true }).some((message) =>
    message.kind === kind
  )) {
    return 'already_sent';
  }
  const claim = getEventAnnouncementDeliveryClaim(db, eventId, kind);
  return claim?.status === 'sent'
    ? 'already_sent'
    : claim
      ? 'already_claimed'
      : undefined;
}

export async function sendClaimedEventAnnouncement(input: {
  db: PluginDatabase;
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementDeliveryKind;
  chatId: string;
  text: string;
  sender: {
    sendText(chatId: string, text: string): Promise<{ messageId?: string | undefined }>;
  };
}): Promise<ClaimedEventAnnouncementResult> {
  const claim = claimEventAnnouncementDelivery(input.db, {
    eventId: input.eventId,
    scopeId: input.scopeId,
    kind: input.kind,
    chatId: input.chatId
  });
  if (claim !== 'claimed') {
    return { status: claim };
  }

  try {
    const sent = await input.sender.sendText(input.chatId, input.text);
    const messageId = sent.messageId?.trim();
    if (!messageId) {
      throw new Error(`${input.kind} transport send returned no WhatsApp message id.`);
    }
    completeEventAnnouncementDelivery(input.db, {
      eventId: input.eventId,
      scopeId: input.scopeId,
      kind: input.kind,
      chatId: input.chatId,
      messageId
    });
    return { status: 'sent', messageId };
  } catch (error) {
    markEventAnnouncementDeliveryUncertain(input.db, {
      eventId: input.eventId,
      kind: input.kind,
      reason: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
