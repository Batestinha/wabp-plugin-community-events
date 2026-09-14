import type {
  PluginDatabase,
  PluginDatabaseRow
} from '@wabs/plugin-sdk/database';
import type { PluginLifecycleContext } from './runtime';
import { eventsDatabase } from './store';

interface EventActorIdentityRow extends PluginDatabaseRow {
  id: string;
  actor_wid: string;
  actor_identity_id: string | null;
}

interface EventVoteIdentityRow extends PluginDatabaseRow {
  event_id: string;
  voter_identity_id: string | null;
  voter_wid: string;
  selected_option_ids_json: string;
  selected_option_names_json: string;
  selected_option_numbers_json: string;
  interacted_at: string | null;
  updated_at: string;
}

interface ResolvedEventVoteIdentityRow extends EventVoteIdentityRow {
  voter_identity_id: string;
}

interface TableColumnRow extends PluginDatabaseRow {
  name: string;
  notnull: number;
  pk: number;
}

export interface EventIdentityMigrationResult {
  actorRowsBackfilled: number;
  voteRowsBefore: number;
  voteRowsAfter: number;
  voteTableRebuilt: boolean;
}

type ResolvePersistedIdentityId = (wid: string) => Promise<string>;

/**
 * Finalizes the additive SQLite identity columns only after every durable WID
 * has an exact principal in the authoritative platform identity service.
 */
export async function migrateEventIdentityData(
  context: PluginLifecycleContext
): Promise<void> {
  const db = eventsDatabase(context.databases);
  const fromVersion = Number(context.fromDataVersion);
  // Version 18 already records successful authoritative identity finalization.
  // Later schema-only upgrades preserve that proof without acquiring platform-only
  // identity services for a separately installed package.
  if (!context.resolvePersistedIdentityId && Number.isSafeInteger(fromVersion) && fromVersion >= 18) {
    const actors = readEventActorIdentityRows(db);
    const votes = readEventVoteIdentityRows(db);
    if (!eventVoteIdentitySchemaIsFinal(db) || actors.some(row => !row.actor_identity_id?.trim()) || votes.some(row => !row.voter_identity_id?.trim())) {
      throw new Error('Previously finalized official.community-events identity data is incomplete.');
    }
    context.logger.info({ actors: actors.length, votes: votes.length }, 'Preserved previously finalized official.community-events identities');
    return;
  }
  const result = await finalizeEventIdentityMigration(
    db,
    context.resolvePersistedIdentityId ?? (async () => {
      throw new Error('official.community-events identity migration requires platform identity access.');
    })
  );
  context.logger.info(result, 'Finalized official.community-events authoritative identity data');
}

/** Exported for deterministic, transport-free migration verification. */
export async function finalizeEventIdentityMigration(
  db: PluginDatabase,
  resolvePersistedIdentityId: ResolvePersistedIdentityId
): Promise<EventIdentityMigrationResult> {
  const actors = readEventActorIdentityRows(db);
  const votes = readEventVoteIdentityRows(db);

  const identityIdsByWid = new Map<string, string>();
  const resolve = async (wid: string): Promise<string> => {
    const normalizedWid = wid.trim();
    if (!normalizedWid) {
      throw new Error('Cannot migrate official.community-events identity data with an empty WhatsApp address.');
    }
    const cached = identityIdsByWid.get(normalizedWid);
    if (cached) return cached;
    const identityId = (await resolvePersistedIdentityId(normalizedWid)).trim();
    if (!identityId) {
      throw new Error(`Cannot migrate official.community-events identity data: ${normalizedWid} resolved without an identity id.`);
    }
    identityIdsByWid.set(normalizedWid, identityId);
    return identityId;
  };

  const actorBackfills: Array<{ eventId: string; identityId: string }> = [];
  for (const actor of actors) {
    const identityId = await resolve(actor.actor_wid);
    const storedIdentityId = actor.actor_identity_id?.trim();
    if (storedIdentityId && storedIdentityId !== identityId) {
      throw new Error(
        `Cannot migrate official.community-events event ${actor.id}: stored actor identity ${storedIdentityId} conflicts with authoritative identity ${identityId}.`
      );
    }
    if (!storedIdentityId) {
      actorBackfills.push({ eventId: actor.id, identityId });
    }
  }

  const resolvedVotes = new Map<string, ResolvedEventVoteIdentityRow>();
  for (const vote of votes) {
    const identityId = await resolve(vote.voter_wid);
    const storedIdentityId = vote.voter_identity_id?.trim();
    if (storedIdentityId && storedIdentityId !== identityId) {
      throw new Error(
        `Cannot migrate official.community-events vote for ${vote.event_id}: stored voter identity ${storedIdentityId} conflicts with authoritative identity ${identityId}.`
      );
    }
    const resolvedVote: ResolvedEventVoteIdentityRow = {
      ...vote,
      voter_identity_id: identityId
    };
    const key = JSON.stringify([vote.event_id, identityId]);
    const current = resolvedVotes.get(key);
    resolvedVotes.set(key, current ? currentVoteState(current, resolvedVote) : resolvedVote);
  }

  const voteTableRebuilt = !eventVoteIdentitySchemaIsFinal(db);
  db.transaction(() => {
    if (
      !sameRows(actors, readEventActorIdentityRows(db)) ||
      !sameRows(votes, readEventVoteIdentityRows(db))
    ) {
      throw new Error(
        'Cannot migrate official.community-events identity data: event identity rows changed while authoritative identities were resolving; retry the migration.'
      );
    }

    for (const actor of actorBackfills) {
      const result = db.run(
        `UPDATE event_records
            SET actor_identity_id = ?
          WHERE id = ?
            AND (actor_identity_id IS NULL OR trim(actor_identity_id) = '')`,
        actor.identityId,
        actor.eventId
      );
      if (result.changes !== 1) {
        throw new Error(`Could not atomically backfill actor identity for event ${actor.eventId}.`);
      }
    }

    if (voteTableRebuilt) {
      db.exec(`
        CREATE TABLE event_votes_authoritative (
          event_id TEXT NOT NULL,
          voter_identity_id TEXT NOT NULL,
          voter_wid TEXT NOT NULL,
          selected_option_ids_json TEXT NOT NULL,
          selected_option_names_json TEXT NOT NULL,
          selected_option_numbers_json TEXT NOT NULL,
          interacted_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (event_id, voter_identity_id),
          FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE CASCADE
        );
      `);
      for (const vote of [...resolvedVotes.values()].sort(compareResolvedVotes)) {
        db.run(
          `INSERT INTO event_votes_authoritative (
             event_id, voter_identity_id, voter_wid,
             selected_option_ids_json, selected_option_names_json,
             selected_option_numbers_json, interacted_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          vote.event_id,
          vote.voter_identity_id,
          vote.voter_wid,
          vote.selected_option_ids_json,
          vote.selected_option_names_json,
          vote.selected_option_numbers_json,
          vote.interacted_at,
          vote.updated_at
        );
      }
      db.exec(`
        DROP TABLE event_votes;
        ALTER TABLE event_votes_authoritative RENAME TO event_votes;
      `);
    }

    const invalidActorCount = db.get<{ count: number }>(
      `SELECT count(*) AS count
         FROM event_records
        WHERE actor_identity_id IS NULL OR trim(actor_identity_id) = ''`
    )?.count ?? 0;
    const invalidVoteCount = db.get<{ count: number }>(
      `SELECT count(*) AS count
         FROM event_votes
        WHERE voter_identity_id IS NULL OR trim(voter_identity_id) = ''`
    )?.count ?? 0;
    const finalVoteCount = db.get<{ count: number }>(
      'SELECT count(*) AS count FROM event_votes'
    )?.count ?? 0;
    if (
      invalidActorCount !== 0 ||
      invalidVoteCount !== 0 ||
      finalVoteCount !== resolvedVotes.size ||
      !eventVoteIdentitySchemaIsFinal(db)
    ) {
      throw new Error(
        'Cannot finalize official.community-events identity data: authoritative actor/voter postconditions were not satisfied.'
      );
    }
  });

  return {
    actorRowsBackfilled: actorBackfills.length,
    voteRowsBefore: votes.length,
    voteRowsAfter: resolvedVotes.size,
    voteTableRebuilt
  };
}

function readEventActorIdentityRows(db: PluginDatabase): EventActorIdentityRow[] {
  return db.all<EventActorIdentityRow>(
    `SELECT id, actor_wid, actor_identity_id
       FROM event_records
      ORDER BY id ASC`
  );
}

function readEventVoteIdentityRows(db: PluginDatabase): EventVoteIdentityRow[] {
  return db.all<EventVoteIdentityRow>(
    `SELECT event_id, voter_identity_id, voter_wid,
            selected_option_ids_json, selected_option_names_json,
            selected_option_numbers_json, interacted_at, updated_at
       FROM event_votes
      ORDER BY event_id ASC, updated_at ASC, voter_wid ASC`
  );
}

function sameRows<T extends PluginDatabaseRow>(left: T[], right: T[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function eventVoteIdentitySchemaIsFinal(db: PluginDatabase): boolean {
  const columns = db.all<TableColumnRow>('PRAGMA table_info(event_votes)');
  const byName = new Map(columns.map((column) => [column.name, column]));
  return byName.get('event_id')?.pk === 1
    && byName.get('voter_identity_id')?.pk === 2
    && byName.get('voter_identity_id')?.notnull === 1;
}

function currentVoteState(
  left: ResolvedEventVoteIdentityRow,
  right: ResolvedEventVoteIdentityRow
): ResolvedEventVoteIdentityRow {
  const updatedComparison = compareIsoInstants(left.updated_at, right.updated_at);
  if (updatedComparison < 0) return right;
  if (updatedComparison > 0) return left;
  if (!sameVoteSelection(left, right)) {
    throw new Error(
      `Cannot migrate official.community-events vote for ${left.event_id}: identity ${left.voter_identity_id} has conflicting states at ${left.updated_at}.`
    );
  }
  return left.voter_wid.localeCompare(right.voter_wid) <= 0 ? left : right;
}

function compareIsoInstants(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    throw new Error(`Cannot migrate official.community-events vote with invalid update timestamps: ${left}, ${right}.`);
  }
  return leftTime - rightTime;
}

function sameVoteSelection(left: EventVoteIdentityRow, right: EventVoteIdentityRow): boolean {
  return left.selected_option_ids_json === right.selected_option_ids_json
    && left.selected_option_names_json === right.selected_option_names_json
    && left.selected_option_numbers_json === right.selected_option_numbers_json
    && left.interacted_at === right.interacted_at;
}

function compareResolvedVotes(
  left: ResolvedEventVoteIdentityRow,
  right: ResolvedEventVoteIdentityRow
): number {
  return left.event_id.localeCompare(right.event_id)
    || left.voter_identity_id.localeCompare(right.voter_identity_id);
}
