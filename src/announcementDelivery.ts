import type { TemplateMessageMentions } from '@wabs/plugin-sdk/templates';
import type { PluginDatabase } from '@wabs/plugin-sdk/database';
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
  | { status: 'already_claimed' }
  | { status: 'superseded' };

export function persistedEventAnnouncementDisposition(
  db: PluginDatabase,
  eventId: string,
  kind: EventAnnouncementDeliveryKind,
  deliveryKey: string
): 'already_sent' | 'already_claimed' | undefined {
  if (listEventAnnouncementMessages(db, eventId, { includeDeleted: true }).some((message) =>
    message.kind === kind && message.deliveryKey === deliveryKey
  )) {
    return 'already_sent';
  }
  const claim = getEventAnnouncementDeliveryClaim(db, eventId, kind, deliveryKey);
  return claim?.status === 'sent'
    ? 'already_sent'
    : claim
      ? 'already_claimed'
      : undefined;
}

export function eventAnnouncementTransportIdempotencyKey(input: {
  eventId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
}): string {
  return `community-events:${input.kind}:${input.eventId}:${input.deliveryKey}`;
}

export async function sendClaimedEventAnnouncement(input: {
  db: PluginDatabase;
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  chatId: string;
  text: string;
  mentions?: TemplateMessageMentions | undefined;
  idempotencyKey?: string | undefined;
  expectedEventUpdatedAt?: string | undefined;
  sender: {
    sendText(
      chatId: string,
      text: string,
      options?: { idempotencyKey?: string | undefined } & TemplateMessageMentions
    ): Promise<{ messageId?: string | undefined }>;
  };
}): Promise<ClaimedEventAnnouncementResult> {
  const idempotencyKey = input.idempotencyKey ?? eventAnnouncementTransportIdempotencyKey(input);
  const frozen = getEventAnnouncementDeliveryClaim(input.db, input.eventId, input.kind, input.deliveryKey);
  const claim = claimEventAnnouncementDelivery(input.db, {
    eventId: input.eventId,
    scopeId: input.scopeId,
    kind: input.kind,
    deliveryKey: input.deliveryKey,
    chatId: input.chatId,
    text: frozen?.text ?? input.text,
    mentions: frozen?.text ? frozen.mentions : input.mentions,
    idempotencyKey,
    ...(input.expectedEventUpdatedAt ? { expectedEventUpdatedAt: input.expectedEventUpdatedAt } : {})
  });
  if (claim !== 'claimed') {
    return { status: claim };
  }

  const persisted = getEventAnnouncementDeliveryClaim(
    input.db,
    input.eventId,
    input.kind,
    input.deliveryKey
  );
  if (
    !persisted ||
    persisted.status !== 'sending' ||
    !persisted.text ||
    !persisted.idempotencyKey
  ) {
    throw new Error(`Claimed ${input.kind} announcement is missing its persisted delivery intent.`);
  }

  try {
    const sent = await input.sender.sendText(persisted.chatId, persisted.text, {
      ...persisted.mentions,
      idempotencyKey: persisted.idempotencyKey
    });
    const messageId = sent.messageId?.trim();
    if (!messageId) {
      throw new Error(`${input.kind} transport send returned no WhatsApp message id.`);
    }
    completeEventAnnouncementDelivery(input.db, {
      eventId: input.eventId,
      scopeId: input.scopeId,
      kind: input.kind,
      deliveryKey: input.deliveryKey,
      chatId: persisted.chatId,
      messageId
    });
    return { status: 'sent', messageId };
  } catch (error) {
    markEventAnnouncementDeliveryUncertain(input.db, {
      eventId: input.eventId,
      kind: input.kind,
      deliveryKey: input.deliveryKey,
      reason: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
