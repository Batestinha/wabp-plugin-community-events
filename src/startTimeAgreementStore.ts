import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PluginDatabase, PluginDatabaseRow } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { EventProfile } from './config';

export const EVENT_START_TIME_BANDS = ['morning', 'afternoon', 'evening'] as const;
export type EventStartTimeBand = (typeof EVENT_START_TIME_BANDS)[number];

export const eventStartTimeAgreementSnapshotSchema = z.object({
  timeQuestionKey: z.string().trim().min(1),
  voterDisclosure: z.enum(['named', 'hidden']),
  bandVotingWindowMinutes: z.number().int().min(1).max(24 * 60),
  exactTimeVotingWindowMinutes: z.number().int().min(1).max(24 * 60),
  configuredDurationMinutes: z.number().int().min(1),
  candidateTimes: z.object({
    morning: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(12),
    afternoon: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(12),
    evening: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(12)
  }).strict()
}).strict();

export type EventStartTimeAgreementSnapshot = z.infer<typeof eventStartTimeAgreementSnapshotSchema>;

export type EventStartTimeAgreementStatus =
  | 'pending_subgroup'
  | 'band_pending'
  | 'band_open'
  | 'exact_pending'
  | 'exact_open'
  | 'organizer_band_pending'
  | 'organizer_band_open'
  | 'organizer_time_pending'
  | 'organizer_time_open'
  | 'applying'
  | 'applied'
  | 'blocked'
  | 'cancelled'
  | 'expired';

export interface StoredEventStartTimeAgreement {
  eventId: string;
  generation: number;
  status: EventStartTimeAgreementStatus;
  config: EventStartTimeAgreementSnapshot;
  bandPollId?: string | undefined;
  exactPollId?: string | undefined;
  organizerBandPollId?: string | undefined;
  organizerTimePollId?: string | undefined;
  bandClosesAt?: string | undefined;
  exactClosesAt?: string | undefined;
  organizerBandClosesAt?: string | undefined;
  organizerTimeClosesAt?: string | undefined;
  winningBand?: EventStartTimeBand | undefined;
  resolvedLocalTime?: string | undefined;
  leaseToken?: string | undefined;
  leaseExpiresAt?: string | undefined;
  nextRunAt?: string | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | undefined;
  cancelledAt?: string | undefined;
}

interface AgreementRow extends PluginDatabaseRow {
  event_id: string;
  generation: number;
  status: EventStartTimeAgreementStatus;
  config_json: string;
  band_poll_id: string | null;
  exact_poll_id: string | null;
  organizer_band_poll_id: string | null;
  organizer_time_poll_id: string | null;
  band_closes_at: string | null;
  exact_closes_at: string | null;
  organizer_band_closes_at: string | null;
  organizer_time_closes_at: string | null;
  winning_band: EventStartTimeBand | null;
  resolved_local_time: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  cancelled_at: string | null;
}

export function eventStartTimeAgreementSnapshot(profile: EventProfile): EventStartTimeAgreementSnapshot {
  return eventStartTimeAgreementSnapshotSchema.parse({
    timeQuestionKey: profile.startsAtTimeQuestionKey,
    voterDisclosure: profile.startTimeAgreement.voterDisclosure,
    bandVotingWindowMinutes: profile.startTimeAgreement.bandVotingWindowMinutes,
    exactTimeVotingWindowMinutes: profile.startTimeAgreement.exactTimeVotingWindowMinutes,
    configuredDurationMinutes: profile.calendar.durationMinutes,
    candidateTimes: profile.startTimeAgreement.candidateTimes
  });
}

export function createEventStartTimeAgreement(
  db: PluginDatabase,
  input: { eventId: string; profile: EventProfile; createdAt: string; nextRunAt?: string | undefined }
): StoredEventStartTimeAgreement {
  const config = eventStartTimeAgreementSnapshot(input.profile);
  db.run(
    `INSERT INTO event_start_time_agreements (
       event_id, generation, status, config_json, next_run_at, created_at, updated_at
     ) VALUES (?, 1, 'pending_subgroup', ?, ?, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
    input.eventId,
    JSON.stringify(config),
    input.nextRunAt ?? input.createdAt,
    input.createdAt,
    input.createdAt
  );
  const agreement = getEventStartTimeAgreement(db, input.eventId);
  if (!agreement) {
    throw new Error(`Unable to persist start-time agreement for event ${input.eventId}.`);
  }
  return agreement;
}

export function getEventStartTimeAgreement(
  db: PluginDatabase,
  eventId: string
): StoredEventStartTimeAgreement | undefined {
  const row = db.get<AgreementRow>(
    'SELECT * FROM event_start_time_agreements WHERE event_id = ?',
    eventId
  );
  return row ? agreementFromRow(row) : undefined;
}

export function listRecoverableEventStartTimeAgreements(
  db: PluginDatabase,
  now = new Date().toISOString()
): StoredEventStartTimeAgreement[] {
  return db.all<AgreementRow>(
    `SELECT agreement.*
       FROM event_start_time_agreements agreement
       JOIN event_records event ON event.id = agreement.event_id
      WHERE agreement.status NOT IN ('applied', 'blocked', 'cancelled', 'expired')
        AND event.event_status = 'active'
        AND (agreement.next_run_at IS NULL OR agreement.next_run_at <= ?)
        AND (agreement.lease_expires_at IS NULL OR agreement.lease_expires_at <= ?)
      ORDER BY agreement.updated_at ASC, agreement.event_id ASC`,
    now,
    now
  ).map(agreementFromRow);
}

export function claimEventStartTimeAgreement(
  db: PluginDatabase,
  input: { eventId: string; now: Date; leaseMs?: number | undefined }
): StoredEventStartTimeAgreement | undefined {
  const leaseToken = randomUUID();
  const now = input.now.toISOString();
  const leaseExpiresAt = new Date(input.now.getTime() + (input.leaseMs ?? 2 * 60_000)).toISOString();
  return db.transaction(() => {
    const changed = db.run(
      `UPDATE event_start_time_agreements
          SET lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE event_id = ?
          AND status NOT IN ('applied', 'blocked', 'cancelled', 'expired')
          AND (next_run_at IS NULL OR next_run_at <= ?)
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      leaseToken,
      leaseExpiresAt,
      now,
      input.eventId,
      now,
      now
    );
    if (changed.changes !== 1) {
      return undefined;
    }
    return getEventStartTimeAgreement(db, input.eventId);
  });
}

export function saveClaimedEventStartTimeAgreement(
  db: PluginDatabase,
  agreement: StoredEventStartTimeAgreement,
  input: { now: Date; nextRunAt?: Date | undefined; lastError?: string | undefined }
): boolean {
  if (!agreement.leaseToken) {
    throw new Error('Saving a start-time agreement requires an active lease.');
  }
  const updatedAt = input.now.toISOString();
  return db.run(
    `UPDATE event_start_time_agreements
        SET generation = ?, status = ?, config_json = ?, band_poll_id = ?, exact_poll_id = ?,
            organizer_band_poll_id = ?, organizer_time_poll_id = ?, band_closes_at = ?,
            exact_closes_at = ?, organizer_band_closes_at = ?, organizer_time_closes_at = ?,
            winning_band = ?,
            resolved_local_time = ?, lease_token = NULL, lease_expires_at = NULL,
            next_run_at = ?, last_error = ?, updated_at = ?, resolved_at = ?, cancelled_at = ?
      WHERE event_id = ? AND lease_token = ?`,
    agreement.generation,
    agreement.status,
    JSON.stringify(agreement.config),
    agreement.bandPollId ?? null,
    agreement.exactPollId ?? null,
    agreement.organizerBandPollId ?? null,
    agreement.organizerTimePollId ?? null,
    agreement.bandClosesAt ?? null,
    agreement.exactClosesAt ?? null,
    agreement.organizerBandClosesAt ?? null,
    agreement.organizerTimeClosesAt ?? null,
    agreement.winningBand ?? null,
    agreement.resolvedLocalTime ?? null,
    input.nextRunAt?.toISOString() ?? null,
    input.lastError ?? agreement.lastError ?? null,
    updatedAt,
    agreement.resolvedAt ?? null,
    agreement.cancelledAt ?? null,
    agreement.eventId,
    agreement.leaseToken
  ).changes === 1;
}

export function cancelEventStartTimeAgreement(
  db: PluginDatabase,
  input: { eventId: string; cancelledAt: string; reason?: string | undefined }
): StoredEventStartTimeAgreement | undefined {
  db.run(
    `UPDATE event_start_time_agreements
        SET status = 'cancelled', cancelled_at = ?, last_error = ?, next_run_at = NULL,
            lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE event_id = ? AND status NOT IN ('applied', 'cancelled', 'expired')`,
    input.cancelledAt,
    input.reason ?? null,
    input.cancelledAt,
    input.eventId
  );
  return getEventStartTimeAgreement(db, input.eventId);
}

export function markEventStartTimeAgreementExternallyResolved(
  db: PluginDatabase,
  input: { eventId: string; localTime: string; resolvedAt: string }
): boolean {
  return db.run(
    `UPDATE event_start_time_agreements
        SET status = 'applying', resolved_local_time = ?, resolved_at = ?, next_run_at = ?,
            last_error = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE event_id = ? AND status NOT IN ('cancelled', 'expired')`,
    input.localTime,
    input.resolvedAt,
    input.resolvedAt,
    input.resolvedAt,
    input.eventId
  ).changes === 1;
}

function agreementFromRow(row: AgreementRow): StoredEventStartTimeAgreement {
  return {
    eventId: row.event_id,
    generation: Number(row.generation),
    status: row.status,
    config: eventStartTimeAgreementSnapshotSchema.parse(JSON.parse(row.config_json)),
    ...(row.band_poll_id ? { bandPollId: row.band_poll_id } : {}),
    ...(row.exact_poll_id ? { exactPollId: row.exact_poll_id } : {}),
    ...(row.organizer_band_poll_id ? { organizerBandPollId: row.organizer_band_poll_id } : {}),
    ...(row.organizer_time_poll_id ? { organizerTimePollId: row.organizer_time_poll_id } : {}),
    ...(row.band_closes_at ? { bandClosesAt: row.band_closes_at } : {}),
    ...(row.exact_closes_at ? { exactClosesAt: row.exact_closes_at } : {}),
    ...(row.organizer_band_closes_at ? { organizerBandClosesAt: row.organizer_band_closes_at } : {}),
    ...(row.organizer_time_closes_at ? { organizerTimeClosesAt: row.organizer_time_closes_at } : {}),
    ...(row.winning_band ? { winningBand: row.winning_band } : {}),
    ...(row.resolved_local_time ? { resolvedLocalTime: row.resolved_local_time } : {}),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {})
  };
}
