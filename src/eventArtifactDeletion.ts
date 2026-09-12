import type { PluginDatabase } from '@wabs/plugin-sdk/database';
import type { MessageDeletionResult } from '@wabs/plugin-sdk/transport';
import {
  listEventAnnouncementMessages,
  markEventAnnouncementMessageDeleted,
  markEventAnnouncementMessageDeleteFailed,
  type EventAnnouncementMessageKind,
  type StoredEventRecord
} from './store';

export interface EventArtifactDeletionResult {
  requested: true;
  attempted: number;
  deleted: EventArtifactDeletionRecord[];
  unconfirmed: EventArtifactDeletionRecord[];
  failed: EventArtifactDeletionFailure[];
  skippedReason?: 'message_delete_unavailable' | undefined;
}

export interface EventArtifactDeletionRecord {
  id: string;
  kind: EventAnnouncementMessageKind;
  chatId: string;
  messageId: string;
}

export interface EventArtifactDeletionFailure extends EventArtifactDeletionRecord {
  reason: string;
}

/**
 * Best-effort removal of selected still-live WhatsApp artifacts recorded for
 * one event (all of them when no id allowlist is supplied). Successful and
 * failed attempts are persisted per message so callers can report exact
 * outcomes and later invocations retry only unfinished rows.
 */
export async function deleteEventArtifacts(input: {
  db: PluginDatabase;
  event: Pick<StoredEventRecord, 'id' | 'scopeId'>;
  deleteMessage?: ((messageId: string) => Promise<MessageDeletionResult | void>) | undefined;
  artifactIds?: readonly string[] | undefined;
}): Promise<EventArtifactDeletionResult> {
  if (!input.deleteMessage) {
    return {
      requested: true,
      attempted: 0,
      deleted: [],
      unconfirmed: [],
      failed: [],
      skippedReason: 'message_delete_unavailable'
    };
  }

  const artifactIds = input.artifactIds ? new Set(input.artifactIds) : undefined;
  const messages = listEventAnnouncementMessages(input.db, input.event.id)
    .filter((message) => (
      message.scopeId === input.event.scopeId &&
      (!artifactIds || artifactIds.has(message.id))
    ));
  const result: EventArtifactDeletionResult = {
    requested: true,
    attempted: messages.length,
    deleted: [],
    unconfirmed: [],
    failed: []
  };
  for (const message of messages) {
    const artifact = {
      id: message.id,
      kind: message.kind,
      chatId: message.chatId,
      messageId: message.messageId
    };
    try {
      const deletion = await input.deleteMessage(message.messageId) ?? { status: 'confirmed' as const };
      if (deletion.status === 'confirmed') {
        markEventAnnouncementMessageDeleted(input.db, message.id, new Date().toISOString());
        result.deleted.push(artifact);
      } else if (deletion.status === 'rejected') {
        markEventAnnouncementMessageDeleteFailed(input.db, message.id, deletion.reason);
        result.failed.push({ ...artifact, reason: deletion.reason });
      } else {
        markEventAnnouncementMessageDeleteFailed(input.db, message.id, 'Deletion submitted; provider confirmation pending.');
        result.unconfirmed.push(artifact);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      markEventAnnouncementMessageDeleteFailed(input.db, message.id, reason);
      result.failed.push({ ...artifact, reason });
    }
  }
  return result;
}
