import { createHash, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../../platform/config/runtimeConfig';
import type { PluginDatabase } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import {
  eventCalendarResourceSchema,
  type EventCalendarResource,
  type EventsConfig
} from './config';
import { publishCalendarBody, type CalendarPublicationOutcome } from './calendarPublication';
import {
  commitPreparedScopeCalendar,
  discardPreparedScopeCalendar,
  prepareScopeCalendar,
  renderScopeCalendar,
  type PreparedScopeCalendar
} from './ics';
import {
  assertScopeEventCalendarOwnershipResolved,
  claimEventCalendarPublication,
  commitEventCalendarLocalGeneration,
  EVENT_CALENDAR_PUBLICATION_LEASE_MS,
  ensureEventCalendarPublicationConfiguration,
  eventCalendarPublicationClaimIsCurrent,
  finishEventCalendarPublicationAttempt,
  getCalendarPublicationStatus,
  getEventCalendarPublicationGeneration,
  listCalendarEvents,
  markEventCalendarPublicationDirty,
  releaseEventCalendarPublicationClaim,
  renewEventCalendarPublicationClaim,
  storeEventCalendarPublicationDocument,
  type EventCalendarPublicationClaim,
  type StoredCalendarPublicationStatus
} from './store';

const CALENDAR_PUBLICATION_LEASE_POLL_MS = 100;

export class EventCalendarPublicationConfigurationSupersededError extends Error {
  constructor(scopeId: string, calendarId: string) {
    super(
      `Calendar publication configuration changed for ${scopeId}/${calendarId}; reload the effective configuration before retrying.`
    );
    this.name = 'EventCalendarPublicationConfigurationSupersededError';
  }
}

export interface RenderedScopeCalendarDocument {
  body: string;
  generatedAt: string;
  eventCount: number;
}

export function renderCurrentScopeCalendarDocument(input: {
  db: PluginDatabase;
  config: EventsConfig;
  scopeId: string;
  calendarId: string;
  now?: Date | undefined;
}): RenderedScopeCalendarDocument {
  assertScopeEventCalendarOwnershipResolved(input.db, input.scopeId);
  const calendar = input.config.calendars.find((candidate) => candidate.id === input.calendarId);
  if (!calendar || !calendar.enabled) {
    throw new Error(`Calendar ${input.calendarId} is not enabled for scope ${input.scopeId}.`);
  }
  const events = listCalendarEvents(input.db, input.scopeId, input.calendarId);
  const now = input.now ?? new Date();
  return {
    body: renderScopeCalendar(input.config, input.scopeId, input.calendarId, events, now),
    generatedAt: now.toISOString(),
    eventCount: events.length
  };
}

export async function writePublishAndRecordScopeCalendar(input: {
  appConfig: AppConfig;
  db: PluginDatabase;
  config: EventsConfig;
  scopeId: string;
  calendarId: string;
  /** Startup recovery consumes an already-dirty generation without creating another one. */
  requestGeneration?: boolean | undefined;
}): Promise<CalendarPublicationOutcome | undefined> {
  assertScopeEventCalendarOwnershipResolved(input.db, input.scopeId);
  const calendar = input.config.calendars.find((candidate) => candidate.id === input.calendarId);
  if (!calendar || !calendar.enabled) {
    return undefined;
  }
  const configFingerprint = eventCalendarPublicationConfigFingerprint(
    input.config,
    input.calendarId
  );
  // A domain caller may have captured config before an authoritative save.
  // Only the recovery reconciler may advance an existing config revision;
  // never let a stale writer move it backwards by last-writer-wins.
  assertCalendarPublicationConfigIsCurrent(
    input.db,
    input.scopeId,
    input.calendarId,
    configFingerprint
  );
  ensureEventCalendarPublicationConfiguration(input.db, {
    scopeId: input.scopeId,
    calendarId: input.calendarId,
    fingerprint: configFingerprint
  });
  if (input.requestGeneration !== false) {
    markEventCalendarPublicationDirty(input.db, {
      scopeId: input.scopeId,
      calendarId: input.calendarId
    });
  }

  const leaseToken = randomUUID();
  for (;;) {
    assertCalendarPublicationConfigIsCurrent(
      input.db,
      input.scopeId,
      input.calendarId,
      configFingerprint
    );
    const lease = claimEventCalendarPublication(input.db, {
      scopeId: input.scopeId,
      calendarId: input.calendarId,
      leaseToken,
      expectedConfigFingerprint: configFingerprint
    });
    if (lease.status === 'clean') {
      return publicationOutcomeFromStored(
        getCalendarPublicationStatus(input.db, input.scopeId, input.calendarId)
      );
    }
    if (lease.status === 'busy') {
      await waitForCalendarPublicationLease(lease.retryAt);
      continue;
    }
    if (lease.status === 'configuration_changed') {
      throw new EventCalendarPublicationConfigurationSupersededError(
        input.scopeId,
        input.calendarId
      );
    }

    const result = await publishClaimedCalendarGeneration(
      input,
      calendar,
      lease.claim,
      configFingerprint
    );
    if (result.status === 'superseded') {
      assertCalendarPublicationConfigIsCurrent(
        input.db,
        input.scopeId,
        input.calendarId,
        configFingerprint
      );
      continue;
    }
    return result.publication;
  }
}

function assertCalendarPublicationConfigIsCurrent(
  db: PluginDatabase,
  scopeId: string,
  calendarId: string,
  configFingerprint: string
): void {
  const state = getEventCalendarPublicationGeneration(db, scopeId, calendarId);
  if (
    state?.requestedConfigFingerprint !== undefined &&
    state.requestedConfigFingerprint !== configFingerprint
  ) {
    throw new EventCalendarPublicationConfigurationSupersededError(scopeId, calendarId);
  }
}

async function publishClaimedCalendarGeneration(
  input: {
    appConfig: AppConfig;
    db: PluginDatabase;
    config: EventsConfig;
    scopeId: string;
    calendarId: string;
  },
  calendar: EventsConfig['calendars'][number],
  claim: EventCalendarPublicationClaim,
  configFingerprint: string
): Promise<
  | { status: 'completed'; publication: CalendarPublicationOutcome | undefined }
  | { status: 'superseded' }
> {
  let prepared: PreparedScopeCalendar | undefined;
  let claimFinished = false;
  let ownershipLost = false;
  let heartbeatError: unknown;
  const renew = (): boolean => {
    try {
      const now = new Date();
      const renewed = renewEventCalendarPublicationClaim(input.db, {
        claim,
        leaseExpiresAt: new Date(now.getTime() + EVENT_CALENDAR_PUBLICATION_LEASE_MS).toISOString(),
        updatedAt: now.toISOString()
      });
      ownershipLost ||= !renewed;
      return renewed;
    } catch (error) {
      heartbeatError ??= error;
      ownershipLost = true;
      return false;
    }
  };
  const heartbeat = setInterval(
    renew,
    Math.max(1_000, Math.floor(EVENT_CALENDAR_PUBLICATION_LEASE_MS / 3))
  );
  heartbeat.unref();

  try {
    const frozen = frozenClaimedCalendarDocument(input, calendar, claim, configFingerprint);
    if (!frozen) {
      return { status: 'superseded' };
    }
    const { document, calendar: frozenCalendar } = frozen;
    prepared = await prepareScopeCalendar({
      appConfig: input.appConfig,
      calendar: frozenCalendar,
      scopeId: input.scopeId,
      body: document.body,
      tempId: `${claim.generation}-${claim.leaseToken}`
    });
    throwCalendarPublicationHeartbeatError(heartbeatError);
    if (ownershipLost || !eventCalendarPublicationClaimIsCurrent(input.db, claim)) {
      return { status: 'superseded' };
    }
    const localCommitted = commitEventCalendarLocalGeneration(
      input.db,
      claim,
      () => commitPreparedScopeCalendar(prepared!)
    );
    if (!localCommitted) {
      return { status: 'superseded' };
    }
    prepared = undefined;

    if (ownershipLost || !renew() || !eventCalendarPublicationClaimIsCurrent(input.db, claim)) {
      throwCalendarPublicationHeartbeatError(heartbeatError);
      return { status: 'superseded' };
    }
    const publication = await publishCalendarBody({
      appConfig: input.appConfig,
      scopeId: input.scopeId,
      calendar: frozenCalendar,
      icsBody: document.body,
      generation: claim.generation
    });
    throwCalendarPublicationHeartbeatError(heartbeatError);
    const completed = !publication || publication.ok;
    const recorded = finishEventCalendarPublicationAttempt(input.db, {
      claim,
      generatedAt: document.generatedAt,
      generatedEventCount: document.eventCount,
      ...(publication ? { publication } : {}),
      completed
    });
    if (!recorded) {
      return { status: 'superseded' };
    }
    claimFinished = true;
    return { status: 'completed', publication };
  } finally {
    clearInterval(heartbeat);
    if (prepared) {
      await discardPreparedScopeCalendar(prepared);
    }
    if (!claimFinished) {
      releaseEventCalendarPublicationClaim(input.db, claim);
    }
  }
}

function frozenClaimedCalendarDocument(
  input: {
    db: PluginDatabase;
    config: EventsConfig;
    scopeId: string;
    calendarId: string;
  },
  calendar: EventCalendarResource,
  claim: EventCalendarPublicationClaim,
  configFingerprint: string
): { document: RenderedScopeCalendarDocument; calendar: EventCalendarResource } | undefined {
  const state = getEventCalendarPublicationGeneration(input.db, input.scopeId, input.calendarId);
  if (state?.documentGeneration === claim.generation) {
    if (
      state.documentBody === undefined ||
      state.documentSha256 === undefined ||
      state.documentConfigFingerprint !== configFingerprint ||
      state.documentCalendarJson === undefined ||
      state.documentGeneratedAt === undefined ||
      state.documentEventCount === undefined
    ) {
      throw new Error(
        `Stored calendar publication document metadata is invalid for ${input.scopeId}/${input.calendarId} generation ${claim.generation}.`
      );
    }
    const actualSha256 = createHash('sha256').update(state.documentBody).digest('hex');
    if (actualSha256 !== state.documentSha256) {
      throw new Error(
        `Stored calendar publication document digest is invalid for ${input.scopeId}/${input.calendarId} generation ${claim.generation}.`
      );
    }
    let frozenCalendar: EventCalendarResource;
    try {
      frozenCalendar = eventCalendarResourceSchema.parse(JSON.parse(state.documentCalendarJson));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Stored calendar publication target is invalid for ${input.scopeId}/${input.calendarId} generation ${claim.generation}: ${reason}`
      );
    }
    if (JSON.stringify(frozenCalendar) !== JSON.stringify(calendar)) {
      throw new Error(
        `Stored calendar publication target does not match its configuration fingerprint for ${input.scopeId}/${input.calendarId} generation ${claim.generation}.`
      );
    }
    return {
      document: {
        body: state.documentBody,
        generatedAt: state.documentGeneratedAt,
        eventCount: state.documentEventCount
      },
      calendar: frozenCalendar
    };
  }
  const document = renderCurrentScopeCalendarDocument(input);
  return storeEventCalendarPublicationDocument(input.db, {
    claim,
    configFingerprint,
    calendarJson: JSON.stringify(calendar),
    body: document.body,
    generatedAt: document.generatedAt,
    eventCount: document.eventCount
  })
    ? { document, calendar }
    : undefined;
}

export function eventCalendarPublicationConfigFingerprint(
  config: EventsConfig,
  calendarId: string
): string {
  const calendar = config.calendars.find((candidate) => candidate.id === calendarId);
  if (!calendar) {
    throw new Error(`Unknown calendar configuration: ${calendarId}`);
  }
  const renderConfiguration = {
    schema: 1,
    calendar,
    profiles: config.eventProfiles
      .map((profile) => ({
        id: profile.id,
        label: profile.label,
        calendarTitleTemplate: profile.calendar.titleTemplate ?? ''
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  };
  return createHash('sha256').update(JSON.stringify(renderConfiguration)).digest('hex');
}

function throwCalendarPublicationHeartbeatError(error: unknown): void {
  if (error === undefined) {
    return;
  }
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(`Calendar publication lease heartbeat failed: ${reason}`);
}

async function waitForCalendarPublicationLease(retryAt: string): Promise<void> {
  const remaining = new Date(retryAt).getTime() - Date.now();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(1, Math.min(CALENDAR_PUBLICATION_LEASE_POLL_MS, remaining)));
  });
}

function publicationOutcomeFromStored(
  status: StoredCalendarPublicationStatus | undefined
): CalendarPublicationOutcome | undefined {
  if (!status?.publicationEnabled) {
    return undefined;
  }
  return {
    enabled: true,
    generation: status.generation,
    attempted: status.attempted,
    ok: status.ok,
    endpointUrl: status.endpointUrl ?? '',
    feedId: status.feedId ?? status.calendarId,
    label: status.label ?? status.calendarId,
    ...(status.subscriptionUrl ? { subscriptionUrl: status.subscriptionUrl } : {}),
    ...(status.calendarUrl ? { calendarUrl: status.calendarUrl } : {}),
    ...(status.targetUpdatedAt ? { updatedAt: status.targetUpdatedAt } : {}),
    ...(status.lastError ? { error: status.lastError } : {})
  };
}
