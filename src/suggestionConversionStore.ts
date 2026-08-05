import { randomUUID } from 'node:crypto';
import type {
  PluginDatabase,
  PluginDatabaseRow
} from '../../../platform/pluginRuntime/runtime/pluginDatabase';

export const EVENT_SUGGESTION_CONVERSION_LEASE_MS = 2 * 60 * 1000;

export type EventSuggestionConversionStatus =
  | 'observed'
  | 'flow_started_pending_reject'
  | 'reject_outcome_unknown'
  | 'completed'
  | 'disappeared';

export interface EventSuggestionConversionKey {
  scopeId: string;
  communityJid: string;
  suggestedGroupJid: string;
  suggestionCreatorJid: string;
}

export interface StoredEventSuggestionConversion extends EventSuggestionConversionKey {
  creatorIdentityId?: string | undefined;
  status: EventSuggestionConversionStatus;
  flowSessionId?: string | undefined;
  attemptCount: number;
  lastError?: string | undefined;
  leaseId?: string | undefined;
  leaseExpiresAt?: string | undefined;
  firstSeenAt: string;
  rejectedAt?: string | undefined;
  flowStartedAt?: string | undefined;
  updatedAt: string;
}

interface EventSuggestionConversionRow extends PluginDatabaseRow {
  scope_id: string;
  community_jid: string;
  suggested_group_jid: string;
  suggestion_creator_jid: string;
  creator_identity_id: string | null;
  status: EventSuggestionConversionStatus;
  flow_session_id: string | null;
  attempt_count: number;
  last_error: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  first_seen_at: string;
  rejected_at: string | null;
  flow_started_at: string | null;
  updated_at: string;
}

export function observeEventSuggestionConversion(
  db: PluginDatabase,
  input: EventSuggestionConversionKey & { observedAt?: string | undefined }
): StoredEventSuggestionConversion {
  const key = normalizedKey(input);
  const observedAt = input.observedAt ?? new Date().toISOString();
  db.run(
    `INSERT INTO community_event_suggestion_conversions (
       scope_id, community_jid, suggested_group_jid, suggestion_creator_jid,
       status, first_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, 'observed', ?, ?)
     ON CONFLICT(scope_id, community_jid, suggested_group_jid, suggestion_creator_jid) DO NOTHING`,
    key.scopeId,
    key.communityJid,
    key.suggestedGroupJid,
    key.suggestionCreatorJid,
    observedAt,
    observedAt
  );
  return requireEventSuggestionConversion(db, key);
}

export function getEventSuggestionConversion(
  db: PluginDatabase,
  input: EventSuggestionConversionKey
): StoredEventSuggestionConversion | undefined {
  const key = normalizedKey(input);
  const row = db.get<EventSuggestionConversionRow>(
    `SELECT * FROM community_event_suggestion_conversions
      WHERE scope_id = ?
        AND community_jid = ?
        AND suggested_group_jid = ?
        AND suggestion_creator_jid = ?`,
    key.scopeId,
    key.communityJid,
    key.suggestedGroupJid,
    key.suggestionCreatorJid
  );
  return row ? fromRow(row) : undefined;
}

export function listEventSuggestionConversions(
  db: PluginDatabase,
  scopeId: string
): StoredEventSuggestionConversion[] {
  const normalizedScopeId = requiredValue(scopeId, 'scopeId');
  return db.all<EventSuggestionConversionRow>(
    `SELECT * FROM community_event_suggestion_conversions
      WHERE scope_id = ?
      ORDER BY first_seen_at ASC, community_jid ASC, suggested_group_jid ASC,
        suggestion_creator_jid ASC`,
    normalizedScopeId
  ).map(fromRow);
}

export function claimEventSuggestionConversion(
  db: PluginDatabase,
  input: EventSuggestionConversionKey & {
    now?: string | undefined;
    leaseExpiresAt?: string | undefined;
  }
): StoredEventSuggestionConversion | undefined {
  const key = normalizedKey(input);
  const now = input.now ?? new Date().toISOString();
  const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
    new Date(now).getTime() + EVENT_SUGGESTION_CONVERSION_LEASE_MS
  ).toISOString();
  const leaseId = `event-suggestion-${randomUUID()}`;
  const updated = db.run(
    `UPDATE community_event_suggestion_conversions
        SET lease_id = ?,
            lease_expires_at = ?,
            attempt_count = attempt_count + 1,
            updated_at = ?
      WHERE scope_id = ?
        AND community_jid = ?
        AND suggested_group_jid = ?
        AND suggestion_creator_jid = ?
        AND status IN ('observed', 'flow_started_pending_reject', 'reject_outcome_unknown')
        AND (lease_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    leaseId,
    leaseExpiresAt,
    now,
    key.scopeId,
    key.communityJid,
    key.suggestedGroupJid,
    key.suggestionCreatorJid,
    now
  );
  if (updated.changes !== 1) {
    return undefined;
  }
  return requireEventSuggestionConversion(db, key);
}

export function bindEventSuggestionCreatorIdentity(
  db: PluginDatabase,
  input: EventSuggestionConversionKey & {
    leaseId: string;
    creatorIdentityId: string;
    updatedAt?: string | undefined;
  }
): StoredEventSuggestionConversion {
  const key = normalizedKey(input);
  const leaseId = requiredValue(input.leaseId, 'leaseId');
  const creatorIdentityId = requiredValue(input.creatorIdentityId, 'creatorIdentityId');
  const current = requireEventSuggestionConversion(db, key);
  if (current.creatorIdentityId && current.creatorIdentityId !== creatorIdentityId) {
    throw new Error(
      `Suggestion creator identity changed from ${current.creatorIdentityId} to ${creatorIdentityId}.`
    );
  }
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const updated = db.run(
    `UPDATE community_event_suggestion_conversions
        SET creator_identity_id = ?, updated_at = ?
      WHERE scope_id = ?
        AND community_jid = ?
        AND suggested_group_jid = ?
        AND suggestion_creator_jid = ?
        AND lease_id = ?
        AND status IN ('observed', 'flow_started_pending_reject', 'reject_outcome_unknown')`,
    creatorIdentityId,
    updatedAt,
    key.scopeId,
    key.communityJid,
    key.suggestedGroupJid,
    key.suggestionCreatorJid,
    leaseId
  );
  if (updated.changes !== 1) {
    throw new Error('Suggestion conversion changed while binding its authoritative creator identity.');
  }
  return requireEventSuggestionConversion(db, key);
}

export function markEventSuggestionFlowStarted(
  db: PluginDatabase,
  input: EventSuggestionConversionKey & {
    leaseId: string;
    flowSessionId: string;
    startedAt?: string | undefined;
  }
): StoredEventSuggestionConversion {
  const key = normalizedKey(input);
  const leaseId = requiredValue(input.leaseId, 'leaseId');
  const flowSessionId = requiredValue(input.flowSessionId, 'flowSessionId');
  const startedAt = input.startedAt ?? new Date().toISOString();
  const updated = db.run(
    `UPDATE community_event_suggestion_conversions
        SET status = 'flow_started_pending_reject',
            flow_session_id = ?,
            flow_started_at = COALESCE(flow_started_at, ?),
            last_error = NULL,
            updated_at = ?
      WHERE scope_id = ?
        AND community_jid = ?
        AND suggested_group_jid = ?
        AND suggestion_creator_jid = ?
        AND lease_id = ?
        AND status = 'observed'`,
    flowSessionId,
    startedAt,
    startedAt,
    key.scopeId,
    key.communityJid,
    key.suggestedGroupJid,
    key.suggestionCreatorJid,
    leaseId
  );
  if (updated.changes !== 1) {
    const current = requireEventSuggestionConversion(db, key);
    if (
      current.status === 'flow_started_pending_reject'
      && current.flowSessionId === flowSessionId
      && current.leaseId === leaseId
    ) {
      return current;
    }
    throw new Error('Suggestion conversion changed while recording its event flow session.');
  }
  return requireEventSuggestionConversion(db, key);
}

export function markEventSuggestionRejectOutcomeUnknown(
  db: PluginDatabase,
  input: EventSuggestionConversionKey & {
    leaseId: string;
    reason: string;
    updatedAt?: string | undefined;
  }
): StoredEventSuggestionConversion {
  return updateClaimedStatus(db, input, {
    from: ['flow_started_pending_reject', 'reject_outcome_unknown'],
    to: 'reject_outcome_unknown',
    error: requiredValue(input.reason, 'reason'),
    releaseLease: true
  });
}

export function completeEventSuggestionConversion(
  db: PluginDatabase,
  input: EventSuggestionConversionKey & {
    leaseId: string;
    rejectedAt?: string | undefined;
  }
): StoredEventSuggestionConversion {
  const rejectedAt = input.rejectedAt ?? new Date().toISOString();
  return updateClaimedStatus(db, { ...input, updatedAt: rejectedAt }, {
    from: ['flow_started_pending_reject', 'reject_outcome_unknown'],
    to: 'completed',
    rejectedAt,
    releaseLease: true
  });
}

export function markEventSuggestionDisappeared(
  db: PluginDatabase,
  input: EventSuggestionConversionKey & { updatedAt?: string | undefined }
): boolean {
  const key = normalizedKey(input);
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  return db.run(
    `UPDATE community_event_suggestion_conversions
        SET status = 'disappeared', last_error = NULL, updated_at = ?
      WHERE scope_id = ?
        AND community_jid = ?
        AND suggested_group_jid = ?
        AND suggestion_creator_jid = ?
        AND status = 'observed'
        AND lease_id IS NULL`,
    updatedAt,
    key.scopeId,
    key.communityJid,
    key.suggestedGroupJid,
    key.suggestionCreatorJid
  ).changes === 1;
}

export function releaseEventSuggestionConversionClaim(
  db: PluginDatabase,
  input: EventSuggestionConversionKey & {
    leaseId: string;
    error?: string | undefined;
    updatedAt?: string | undefined;
  }
): boolean {
  const key = normalizedKey(input);
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  return db.run(
    `UPDATE community_event_suggestion_conversions
        SET lease_id = NULL,
            lease_expires_at = NULL,
            last_error = ?,
            updated_at = ?
      WHERE scope_id = ?
        AND community_jid = ?
        AND suggested_group_jid = ?
        AND suggestion_creator_jid = ?
        AND lease_id = ?`,
    input.error?.trim() || null,
    updatedAt,
    key.scopeId,
    key.communityJid,
    key.suggestedGroupJid,
    key.suggestionCreatorJid,
    requiredValue(input.leaseId, 'leaseId')
  ).changes === 1;
}

export function releaseExpiredEventSuggestionConversionClaims(
  db: PluginDatabase,
  now: string = new Date().toISOString()
): number {
  return db.run(
    `UPDATE community_event_suggestion_conversions
        SET lease_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE lease_id IS NOT NULL
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND status IN ('observed', 'flow_started_pending_reject', 'reject_outcome_unknown')`,
    now,
    now
  ).changes;
}

function updateClaimedStatus(
  db: PluginDatabase,
  input: EventSuggestionConversionKey & {
    leaseId: string;
    updatedAt?: string | undefined;
  },
  transition: {
    from: EventSuggestionConversionStatus[];
    to: EventSuggestionConversionStatus;
    error?: string | undefined;
    rejectedAt?: string | undefined;
    releaseLease: boolean;
  }
): StoredEventSuggestionConversion {
  const key = normalizedKey(input);
  const leaseId = requiredValue(input.leaseId, 'leaseId');
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const placeholders = transition.from.map(() => '?').join(', ');
  const updated = db.run(
    `UPDATE community_event_suggestion_conversions
        SET status = ?,
            rejected_at = COALESCE(rejected_at, ?),
            last_error = ?,
            lease_id = ?,
            lease_expires_at = ?,
            updated_at = ?
      WHERE scope_id = ?
        AND community_jid = ?
        AND suggested_group_jid = ?
        AND suggestion_creator_jid = ?
        AND lease_id = ?
        AND status IN (${placeholders})`,
    transition.to,
    transition.rejectedAt ?? null,
    transition.error ?? null,
    transition.releaseLease ? null : leaseId,
    transition.releaseLease ? null : requireEventSuggestionConversion(db, key).leaseExpiresAt ?? null,
    updatedAt,
    key.scopeId,
    key.communityJid,
    key.suggestedGroupJid,
    key.suggestionCreatorJid,
    leaseId,
    ...transition.from
  );
  if (updated.changes !== 1) {
    throw new Error(`Suggestion conversion changed while transitioning to ${transition.to}.`);
  }
  return requireEventSuggestionConversion(db, key);
}

function requireEventSuggestionConversion(
  db: PluginDatabase,
  key: EventSuggestionConversionKey
): StoredEventSuggestionConversion {
  const record = getEventSuggestionConversion(db, key);
  if (!record) {
    throw new Error('Event suggestion conversion record is missing.');
  }
  return record;
}

function normalizedKey(input: EventSuggestionConversionKey): EventSuggestionConversionKey {
  return {
    scopeId: requiredValue(input.scopeId, 'scopeId'),
    communityJid: requiredValue(input.communityJid, 'communityJid').toLowerCase(),
    suggestedGroupJid: requiredValue(input.suggestedGroupJid, 'suggestedGroupJid').toLowerCase(),
    suggestionCreatorJid: requiredValue(
      input.suggestionCreatorJid,
      'suggestionCreatorJid'
    ).toLowerCase()
  };
}

function requiredValue(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} is required.`);
  }
  return normalized;
}

function fromRow(row: EventSuggestionConversionRow): StoredEventSuggestionConversion {
  return {
    scopeId: row.scope_id,
    communityJid: row.community_jid,
    suggestedGroupJid: row.suggested_group_jid,
    suggestionCreatorJid: row.suggestion_creator_jid,
    ...(row.creator_identity_id ? { creatorIdentityId: row.creator_identity_id } : {}),
    status: row.status,
    ...(row.flow_session_id ? { flowSessionId: row.flow_session_id } : {}),
    attemptCount: row.attempt_count,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    firstSeenAt: row.first_seen_at,
    ...(row.rejected_at ? { rejectedAt: row.rejected_at } : {}),
    ...(row.flow_started_at ? { flowStartedAt: row.flow_started_at } : {}),
    updatedAt: row.updated_at
  };
}
