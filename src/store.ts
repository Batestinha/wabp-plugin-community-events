import { createHash, randomUUID } from 'node:crypto';
import type { PluginPollVote } from '../../../platform/pluginRuntime/types';
import type {
  CreatedGroupParticipantResult,
  MessageDeletionResult,
  PersistedRequiredCreatorReference
} from '../../../platform/transport/transportTypes';
import { equivalentWhatsAppMessageIds } from '../../../platform/transport/messageIds';
import type { PluginDatabase, PluginDatabaseRow, PluginDatabaseRegistry } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { CalendarPublicationOutcome } from './calendarPublication';
import { EVENTS_DATABASE } from './manifest';
import type { EventSpanKind } from './span';
import { inferredEventSpanKind } from './span';

export type EventStatus = 'active' | 'completed' | 'cancelled' | 'failed';
export type EventGroupLifecycleStatus = 'poll_open' | 'poll_closed' | 'cleanup_failed' | 'cleaned' | 'missed' | 'none';
export type EventCalendarStatus = 'included' | 'cancelled' | 'hidden';
export type EventCalendarOwnershipStatus = 'assigned' | 'none' | 'unresolved';
export type EventOrigin = 'created' | 'unplanned' | 'adopted_poll' | 'adopted_group' | 'adopted_pair';
export type EventWeatherDeliveryScheduleKind = 'poll-close' | 'daily';
export type EventWeatherDeliveryStatus = 'pending' | 'sending' | 'sent' | 'skipped';
export type EventAnnouncementMessageKind = 'poll' | 'calendar_hint' | 'event_group_hint' | 'event_edit' | 'cancellation_notice';
export type EventAnnouncementDeliveryKind = Exclude<EventAnnouncementMessageKind, 'poll' | 'cancellation_notice'>;
export type EventArtifactDeletionStatus = 'pending' | 'confirmed' | 'unconfirmed' | 'rejected' | 'failed';
export type EventAnnouncementDeliveryClaimStatus = 'pending' | 'sending' | 'sent' | 'uncertain' | 'superseded';
export type EventAnnouncementDeliveryClaimResult = 'claimed' | 'already_sent' | 'already_claimed' | 'superseded';
export type EventEditRepairStatus = 'pending' | 'completed';
export type EventPollReplacementStatus = 'pending' | 'published' | 'completed' | 'aborted';
export type EventQuestionKeyRenameStatus = 'expanded' | 'completed' | 'rolled_back';
export type UnplannedEventFinalizationStatus = 'pending' | 'completed';

export const EVENT_CLEANUP_CLAIM_LEASE_MS = 15 * 60 * 1000;
export const EVENT_EDIT_REPAIR_EXECUTION_LEASE_MS = 2 * 60 * 1000;
export const EVENT_ANNOUNCEMENT_DELIVERY_LEASE_MS = 2 * 60 * 1000;
export const EVENT_CALENDAR_PUBLICATION_LEASE_MS = 45 * 1000;
export const EVENT_CALENDAR_PUBLICATION_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000
] as const;
export const EVENT_WEATHER_DELIVERY_LEASE_MS = 5 * 60 * 1000;

export class EventQuestionKeyRenameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventQuestionKeyRenameConflictError';
  }
}

export class EventPollReplacementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventPollReplacementConflictError';
  }
}

export interface EventCleanupClaim {
  eventId: string;
  claimId: string;
  expectedEventUpdatedAt: string;
  claimedCleanupAt: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface RejectedEventChildReplacementExpectation {
  eventId: string;
  scopeId: string;
  rejectedSubgroupChatId: string;
  expectedUpdatedAt: string;
  expectedProvisioningGeneration: string;
  expectedProvisioningAttempt: number;
  expectedProvisioningHaltedAt: string;
  operationId: string;
  failureKind: 'community_link_rejected';
  reason: string;
  actorWid: string;
  actorLabel: string;
}

export type RejectedEventChildReplacementClaimResult =
  | {
      status: 'claimed';
      event: StoredEventRecord;
      claim: EventCleanupClaim;
      creator: PersistedRequiredCreatorReference;
      replayed: boolean;
    }
  | {
      status: 'in_progress';
      event: StoredEventRecord;
      claim: EventCleanupClaim;
    }
  | {
      status: 'already_scheduled';
      event: StoredEventRecord;
      replacementGeneration: string;
    }
  | {
      status: 'already_expired';
      event: StoredEventRecord;
    }
  | {
      status: 'not_found' | 'rejected';
      reason: string;
      event?: StoredEventRecord | undefined;
    };

export type RejectedEventChildReplacementOperationStatus =
  | {
      status: 'already_scheduled';
      event: StoredEventRecord;
      replacementGeneration: string;
    }
  | {
      status: 'already_expired';
      event: StoredEventRecord;
    }
  | {
      status: 'in_progress';
      event: StoredEventRecord;
      claim: EventCleanupClaim;
    }
  | {
      status: 'dismantle_authorized';
      event: StoredEventRecord;
    }
  | {
      status: 'aborted';
      event: StoredEventRecord;
      reason: string;
    };

export interface EventAnnouncementDeliveryIntent {
  scopeId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  chatId: string;
  text: string;
  idempotencyKey: string;
}

export type EventCalendarHintTrigger = 'poll_published' | 'unplanned_created' | 'unplanned_recovery';

export interface EventCalendarHintDeliveryIntent {
  trigger: EventCalendarHintTrigger;
  calendarId: string;
  locale: string;
  timezone: string;
  creatorDisplayName: string;
  expectedEventUpdatedAt: string;
  groupJoinUrl?: string | undefined;
  subgroupChatId?: string | undefined;
}

export type EventCalendarHintIntentPreparationResult =
  | 'prepared'
  | 'already_sent'
  | 'already_claimed'
  | 'superseded';

export interface EventEditRepairIntent {
  operationId: string;
  scopeId: string;
  subgroupChatId?: string | undefined;
  targetGroupTitle: string;
  calendarId: string;
  announcementDeliveryKey?: string | undefined;
  calendarHintDeliveryKey?: string | undefined;
  calendarHintLocale?: string | undefined;
}

export interface StoredEventQuestionKeyRename {
  operationId: string;
  scopeId: string;
  profileId: string;
  oldKey: string;
  newKey: string;
  oldProfileRevision: string;
  newProfileRevision: string;
  status: EventQuestionKeyRenameStatus;
  migratedEventCount: number;
  leaseExpiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredEventPollOption {
  id: string;
  label: string;
  responseClassId: string;
}

export interface StoredEventResponseClass {
  id: string;
  label: string;
  includeInEventGroup: boolean;
  includeInAttendanceCount: boolean;
}

export interface StoredEventLocation {
  source: 'question' | 'fixed';
  displayLabel: string;
  resolvedLabel: string;
  latitude: number;
  longitude: number;
  timezone: string;
  query?: string | undefined;
  provider?: string | undefined;
  providerRef?: string | undefined;
}

export interface StoredEventRecord {
  id: string;
  scopeId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  profileId: string;
  profileRevision: string;
  profileLabel: string;
  origin: EventOrigin;
  eventStatus: EventStatus;
  groupLifecycleStatus: EventGroupLifecycleStatus;
  calendarStatus: EventCalendarStatus;
  /**
   * Immutable calendar ownership captured when the event is created. A null
   * value is reserved for pre-028 rows whose ownership still requires an
   * explicit, persisted migration decision.
   */
  calendarId: string | null;
  calendarOwnershipStatus: EventCalendarOwnershipStatus;
  /**
   * The authoritative creator principal. Legacy rows migrated from the
   * WID-only schema have no value and therefore receive no creator privilege.
   */
  actorIdentityId?: string | undefined;
  actorWid: string;
  actorLabel: string;
  announcementGroupWid?: string | undefined;
  pollWaMsgId?: string | undefined;
  /** Monotonically advances whenever an open poll is replaced in-place. */
  pollGeneration: number;
  pollQuestion?: string | undefined;
  pollOptions: StoredEventPollOption[];
  responseClasses: StoredEventResponseClass[];
  answers: Record<string, string>;
  eventLocation?: StoredEventLocation | undefined;
  startsAt: string;
  startsAtUtc?: string | undefined;
  endsAt: string;
  /** Authoritative lifecycle boundary. Date-only events may complete later than their nominal duration. */
  lifecycleCompleteAt: string;
  spanKind: EventSpanKind;
  timezone: string;
  localDate?: string | undefined;
  localTime?: string | undefined;
  place?: string | undefined;
  closeAt: string;
  cleanupAt: string;
  groupTitle: string;
  calendarDurationMinutes: number;
  calendarLocation?: string | undefined;
  calendarDescription?: string | undefined;
  subgroupChatId?: string | undefined;
  subgroupTitle?: string | undefined;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | undefined;
  cleanedAt?: string | undefined;
  cancelledAt?: string | undefined;
  cancelledByWid?: string | undefined;
  cancelledByLabel?: string | undefined;
  cancelReason?: string | undefined;
  error?: string | undefined;
  provisioningRecoveryGeneration?: string | undefined;
  provisioningRecoveryAttempt?: number | undefined;
  provisioningRecoveryNextRunAt?: string | undefined;
  provisioningRecoveryHaltedAt?: string | undefined;
}

export interface StoredUnplannedEventFinalization {
  eventId: string;
  scopeId: string;
  eventUpdatedAt: string;
  generation: string;
  attempt: number;
  status: UnplannedEventFinalizationStatus;
  nextRunAt?: string | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
}

export type NewStoredEventRecord = Omit<
  StoredEventRecord,
  'actorIdentityId' | 'calendarOwnershipStatus' | 'pollGeneration' | 'endsAt' | 'lifecycleCompleteAt' | 'spanKind'
> & {
  actorIdentityId: string;
  calendarOwnershipStatus: Exclude<EventCalendarOwnershipStatus, 'unresolved'>;
  pollGeneration?: number | undefined;
  endsAt?: string | undefined;
  lifecycleCompleteAt?: string | undefined;
  spanKind?: EventSpanKind | undefined;
};

export interface EventPollReplacementTarget {
  profileLabel: string;
  profileRevision: string;
  pollQuestion: string;
  pollOptions: StoredEventPollOption[];
  responseClasses: StoredEventResponseClass[];
  answers: Record<string, string>;
  eventLocation?: StoredEventLocation | undefined;
  startsAt: string;
  startsAtUtc: string;
  endsAt?: string | undefined;
  lifecycleCompleteAt?: string | undefined;
  spanKind?: EventSpanKind | undefined;
  timezone: string;
  localDate: string;
  localTime?: string | undefined;
  place?: string | undefined;
  closeAt: string;
  cleanupAt: string;
  groupTitle: string;
  calendarDurationMinutes: number;
  calendarLocation?: string | undefined;
  calendarDescription?: string | undefined;
  allowMultipleAnswers: boolean;
  announcementIntent?: EventAnnouncementDeliveryIntent | undefined;
  repairIntent?: EventEditRepairIntent | undefined;
}

export interface StoredEventPollReplacement {
  operationId: string;
  eventId: string;
  scopeId: string;
  status: EventPollReplacementStatus;
  expectedEventUpdatedAt: string;
  oldPollWaMsgId: string;
  oldPollGeneration: number;
  target: EventPollReplacementTarget;
  editorIdentityId: string;
  editorWid: string;
  editorLabel: string;
  locale: string;
  sourcePluginId: string;
  artifactIds: string[];
  publishIdempotencyKey: string;
  newPollWaMsgId?: string | undefined;
  publicationClaimToken?: string | undefined;
  publicationLeaseExpiresAt?: string | undefined;
  publicationStartedAt?: string | undefined;
  failureCount: number;
  nextAttemptAt?: string | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string | undefined;
  swappedAt?: string | undefined;
  completedAt?: string | undefined;
  retiredAt?: string | undefined;
  retirementError?: string | undefined;
  retirementFailureCount: number;
  receiptReleasedAt?: string | undefined;
  receiptReleaseError?: string | undefined;
  receiptReleaseFailureCount: number;
  receiptReleaseNextAttemptAt?: string | undefined;
}

export interface EventPollReplacementPublicationClaim {
  operationId: string;
  claimToken: string;
  leaseExpiresAt: string;
}

export interface UnassignedEventCalendarOwnership {
  eventId: string;
  scopeId: string;
  profileId: string;
  actorIdentityId: string;
}

export interface StoredEventVote {
  eventId: string;
  voterIdentityId: string;
  voterWid: string;
  selectedOptionIds: string[];
  selectedOptionNames: string[];
  selectedOptionNumbers: number[];
  interactedAt?: string | undefined;
  updatedAt: string;
}

export interface StoredCreatedGroupParticipant {
  eventId: string;
  wid: string;
  identityId?: string | undefined;
  evidenceDigest?: string | undefined;
  statusCode?: number | undefined;
  message?: string | undefined;
  isGroupCreator: boolean;
  isInviteV4Sent: boolean;
  requiredCreatorMembershipStatus?: CreatedGroupParticipantResult['requiredCreatorMembershipStatus'];
  createdAt: string;
}

/**
 * Stable creator principal paired with the exact observed/provider WID whose
 * outcome is being checkpointed. The WID is evidence, never the principal.
 */
export interface EventCreatorParticipantPrincipal {
  identityId: string;
  participantWid: string;
  evidenceDigest?: string | undefined;
}

export interface StoredCalendarPublicationStatus {
  scopeId: string;
  calendarId: string;
  generation: number;
  generatedAt: string;
  generatedEventCount: number;
  publicationEnabled: boolean;
  attempted: boolean;
  ok: boolean;
  endpointUrl?: string | undefined;
  feedId?: string | undefined;
  label?: string | undefined;
  subscriptionUrl?: string | undefined;
  calendarUrl?: string | undefined;
  targetUpdatedAt?: string | undefined;
  lastSuccessAt?: string | undefined;
  lastErrorAt?: string | undefined;
  lastError?: string | undefined;
  updatedAt: string;
}

export interface StoredEventCalendarPublicationGeneration {
  scopeId: string;
  calendarId: string;
  requestedGeneration: number;
  localGeneration: number;
  completedGeneration: number;
  leaseToken?: string | undefined;
  leaseGeneration?: number | undefined;
  leaseExpiresAt?: string | undefined;
  failureCount: number;
  nextAttemptAt?: string | undefined;
  requestedConfigFingerprint?: string | undefined;
  documentGeneration?: number | undefined;
  documentBody?: string | undefined;
  documentSha256?: string | undefined;
  documentConfigFingerprint?: string | undefined;
  documentCalendarJson?: string | undefined;
  documentEventsJson?: string | undefined;
  documentGeneratedAt?: string | undefined;
  documentEventCount?: number | undefined;
  completedConfigFingerprint?: string | undefined;
  updatedAt: string;
}

export interface EventCalendarPublicationClaim {
  scopeId: string;
  calendarId: string;
  generation: number;
  leaseToken: string;
  leaseExpiresAt: string;
}

export type EventCalendarPublicationClaimResult =
  | { status: 'claimed'; claim: EventCalendarPublicationClaim }
  | { status: 'busy'; retryAt: string }
  | { status: 'configuration_changed'; state: StoredEventCalendarPublicationGeneration }
  | { status: 'clean'; state: StoredEventCalendarPublicationGeneration };

export interface StoredEventWeatherDelivery {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  scheduleKind: EventWeatherDeliveryScheduleKind;
  scheduledAt: string;
  status: EventWeatherDeliveryStatus;
  chatId?: string | undefined;
  meteorologicalText?: string | undefined;
  marineText?: string | undefined;
  meteorologicalIdempotencyKey?: string | undefined;
  marineIdempotencyKey?: string | undefined;
  meteorologicalMessageId?: string | undefined;
  marineMessageId?: string | undefined;
  claimId?: string | undefined;
  leaseExpiresAt?: string | undefined;
  attempt: number;
  nextRunAt?: string | undefined;
  sentAt?: string | undefined;
  skippedAt?: string | undefined;
  error?: string | undefined;
  updatedAt: string;
}

export interface ClaimedEventWeatherDelivery {
  claimId: string;
  delivery: StoredEventWeatherDelivery;
}

export interface StoredEventAnnouncementMessage {
  id: string;
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementMessageKind;
  deliveryKey: string;
  chatId: string;
  messageId: string;
  createdAt: string;
  deletedAt?: string | undefined;
  deleteError?: string | undefined;
  deletionStatus?: EventArtifactDeletionStatus | undefined;
  deletionAttemptCount: number;
  deletionNextAttemptAt?: string | undefined;
  deletionSubmittedAt?: string | undefined;
  deletionConfirmedAt?: string | undefined;
  deletionFinalizedAt?: string | undefined;
  deletionLastError?: string | undefined;
}

export interface StoredEventAnnouncementDeliveryClaim {
  eventId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  scopeId: string;
  chatId: string;
  status: EventAnnouncementDeliveryClaimStatus;
  text?: string | undefined;
  idempotencyKey?: string | undefined;
  leaseExpiresAt?: string | undefined;
  messageId?: string | undefined;
  error?: string | undefined;
  calendarHintIntent?: EventCalendarHintDeliveryIntent | undefined;
  claimedAt: string;
  updatedAt: string;
}

export interface StoredEventEditRepair {
  operationId: string;
  eventId: string;
  scopeId: string;
  expectedEventUpdatedAt: string;
  subgroupChatId?: string | undefined;
  targetGroupTitle: string;
  calendarId: string;
  announcementDeliveryKey?: string | undefined;
  calendarHintDeliveryKey?: string | undefined;
  calendarHintLocale?: string | undefined;
  status: EventEditRepairStatus;
  executionClaimId?: string | undefined;
  executionLeaseExpiresAt?: string | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
}

export interface EventEditRepairExecutionClaim {
  operationId: string;
  claimId: string;
  leaseExpiresAt: string;
}

interface EventRow extends PluginDatabaseRow {
  id: string;
  scope_id: string;
  group_id: string | null;
  group_wid: string | null;
  profile_id: string;
  profile_revision: string | null;
  profile_label: string;
  origin: EventOrigin;
  event_status: EventStatus;
  group_lifecycle_status: EventGroupLifecycleStatus;
  calendar_status: EventCalendarStatus;
  calendar_id: string | null;
  calendar_ownership_status: EventCalendarOwnershipStatus;
  actor_identity_id: string | null;
  actor_wid: string;
  actor_label: string;
  announcement_group_wid: string | null;
  poll_wa_msg_id: string | null;
  poll_generation: number;
  poll_question: string | null;
  poll_options_json: string;
  response_classes_json: string;
  answers_json: string;
  event_location_json: string | null;
  starts_at: string;
  starts_at_utc: string | null;
  ends_at: string | null;
  lifecycle_complete_at: string | null;
  span_kind: EventSpanKind | null;
  timezone: string;
  local_date: string | null;
  local_time: string | null;
  place: string | null;
  style: string | null;
  close_at: string;
  cleanup_at: string;
  group_title: string;
  calendar_duration_minutes: number;
  calendar_location: string | null;
  calendar_description: string | null;
  subgroup_chat_id: string | null;
  subgroup_title: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  cleaned_at: string | null;
  cancelled_at: string | null;
  cancelled_by_wid: string | null;
  cancelled_by_label: string | null;
  cancel_reason: string | null;
  error: string | null;
  provisioning_recovery_generation: string | null;
  provisioning_recovery_attempt: number | null;
  provisioning_recovery_next_run_at: string | null;
  provisioning_recovery_halted_at: string | null;
}

interface EventPollReplacementRow extends PluginDatabaseRow {
  operation_id: string;
  event_id: string;
  scope_id: string;
  status: EventPollReplacementStatus;
  expected_event_updated_at: string;
  old_poll_wa_msg_id: string;
  old_poll_generation: number;
  target_json: string;
  editor_identity_id: string;
  editor_wid: string;
  editor_label: string;
  locale: string;
  source_plugin_id: string;
  artifact_ids_json: string;
  publish_idempotency_key: string;
  new_poll_wa_msg_id: string | null;
  publication_claim_token: string | null;
  publication_lease_expires_at: string | null;
  publication_started_at: string | null;
  failure_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  swapped_at: string | null;
  completed_at: string | null;
  retired_at: string | null;
  retirement_error: string | null;
  retirement_failure_count: number;
  receipt_released_at: string | null;
  receipt_release_error: string | null;
  receipt_release_failure_count: number;
  receipt_release_next_attempt_at: string | null;
}

interface VoteRow extends PluginDatabaseRow {
  event_id: string;
  voter_identity_id: string;
  voter_wid: string;
  selected_option_ids_json: string;
  selected_option_names_json: string;
  selected_option_numbers_json: string;
  interacted_at: string | null;
  updated_at: string;
}

interface CalendarPublicationStatusRow extends PluginDatabaseRow {
  scope_id: string;
  calendar_id: string;
  generation: number;
  generated_at: string;
  generated_event_count: number;
  publication_enabled: number;
  attempted: number;
  ok: number;
  endpoint_url: string | null;
  feed_id: string | null;
  label: string | null;
  subscription_url: string | null;
  calendar_url: string | null;
  target_updated_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  updated_at: string;
}

interface EventCalendarPublicationGenerationRow extends PluginDatabaseRow {
  scope_id: string;
  calendar_id: string;
  requested_generation: number;
  local_generation: number;
  completed_generation: number;
  lease_token: string | null;
  lease_generation: number | null;
  lease_expires_at: string | null;
  failure_count: number;
  next_attempt_at: string | null;
  requested_config_fingerprint: string | null;
  document_generation: number | null;
  document_body: string | null;
  document_sha256: string | null;
  document_config_fingerprint: string | null;
  document_calendar_json: string | null;
  document_events_json: string | null;
  document_generated_at: string | null;
  document_event_count: number | null;
  completed_config_fingerprint: string | null;
  updated_at: string;
}

interface EventWeatherDeliveryRow extends PluginDatabaseRow {
  event_id: string;
  event_updated_at: string;
  kind: string;
  schedule_kind: EventWeatherDeliveryScheduleKind;
  scheduled_at: string;
  status: EventWeatherDeliveryStatus;
  chat_id: string | null;
  meteorological_text: string | null;
  marine_text: string | null;
  meteorological_idempotency_key: string | null;
  marine_idempotency_key: string | null;
  meteorological_message_id: string | null;
  marine_message_id: string | null;
  claim_id: string | null;
  lease_expires_at: string | null;
  attempt: number;
  next_run_at: string | null;
  sent_at: string | null;
  skipped_at: string | null;
  error: string | null;
  updated_at: string;
}

interface EventAnnouncementMessageRow extends PluginDatabaseRow {
  id: string;
  event_id: string;
  scope_id: string;
  kind: EventAnnouncementMessageKind;
  delivery_key: string;
  chat_id: string;
  message_id: string;
  created_at: string;
  deleted_at: string | null;
  delete_error: string | null;
  deletion_status: EventArtifactDeletionStatus | null;
  deletion_attempt_count: number;
  deletion_next_attempt_at: string | null;
  deletion_submitted_at: string | null;
  deletion_confirmed_at: string | null;
  deletion_finalized_at: string | null;
  deletion_last_error: string | null;
}

interface EventAnnouncementDeliveryClaimRow extends PluginDatabaseRow {
  event_id: string;
  kind: EventAnnouncementDeliveryKind;
  delivery_key: string;
  scope_id: string;
  chat_id: string;
  status: EventAnnouncementDeliveryClaimStatus;
  text: string | null;
  idempotency_key: string | null;
  lease_expires_at: string | null;
  message_id: string | null;
  error: string | null;
  calendar_hint_intent_json: string | null;
  claimed_at: string;
  updated_at: string;
}

interface UnplannedEventFinalizationRow extends PluginDatabaseRow {
  event_id: string;
  scope_id: string;
  event_updated_at: string;
  generation: string;
  attempt: number;
  next_run_at: string | null;
  status: UnplannedEventFinalizationStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface EventEditRepairRow extends PluginDatabaseRow {
  operation_id: string;
  event_id: string;
  scope_id: string;
  expected_event_updated_at: string;
  subgroup_chat_id: string | null;
  target_group_title: string;
  calendar_id: string;
  announcement_delivery_key: string | null;
  calendar_hint_delivery_key: string | null;
  calendar_hint_locale: string | null;
  status: EventEditRepairStatus;
  execution_claim_id: string | null;
  execution_lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface EventCleanupClaimRow extends PluginDatabaseRow {
  event_id: string;
  claim_id: string;
  expected_event_updated_at: string;
  claimed_cleanup_at: string;
  claimed_at: string;
  lease_expires_at: string;
}

interface EventQuestionKeyRenameRow extends PluginDatabaseRow {
  operation_id: string;
  scope_id: string;
  profile_id: string;
  old_key: string;
  new_key: string;
  old_profile_revision: string | null;
  new_profile_revision: string | null;
  status: EventQuestionKeyRenameStatus;
  migrated_event_count: number;
  lease_expires_at: string;
  created_at: string;
  updated_at: string;
}

export function eventsDatabase(registry: PluginDatabaseRegistry | undefined): PluginDatabase {
  if (!registry) {
    throw new Error('official.community-events requires its plugin database registry.');
  }
  return registry.open(EVENTS_DATABASE);
}

export function newEventId(): string {
  return `evt-${randomUUID().slice(0, 8)}`;
}

export function resolvedEventCalendarId(event: StoredEventRecord): string | undefined {
  if (event.calendarOwnershipStatus === 'unresolved') {
    throw new Error(`Event ${event.id} has unresolved calendar ownership.`);
  }
  if (event.calendarOwnershipStatus === 'none') {
    return undefined;
  }
  const calendarId = event.calendarId?.trim() ?? '';
  if (!calendarId) {
    throw new Error(`Event ${event.id} has invalid assigned calendar ownership.`);
  }
  return calendarId;
}

export function configuredEventCalendarOwnership(calendarId: string): Pick<
  NewStoredEventRecord,
  'calendarId' | 'calendarOwnershipStatus'
> {
  const normalized = calendarId.trim();
  return normalized
    ? { calendarId: normalized, calendarOwnershipStatus: 'assigned' }
    : { calendarId: null, calendarOwnershipStatus: 'none' };
}

export function beginEventQuestionKeyRename(db: PluginDatabase, input: {
  operationId: string;
  scopeId: string;
  profileId: string;
  oldKey: string;
  newKey: string;
  oldProfileRevision: string;
  newProfileRevision: string;
  leaseExpiresAt: string;
  createdAt?: string | undefined;
}): StoredEventQuestionKeyRename {
  if (!input.oldProfileRevision.trim() || !input.newProfileRevision.trim()) {
    throw new EventQuestionKeyRenameConflictError('Event profile revisions are required for a question-key rename.');
  }
  return db.transaction(() => {
    const active = db.get<EventQuestionKeyRenameRow>(
      `SELECT *
         FROM event_question_key_renames
        WHERE scope_id = ? AND profile_id = ? AND status = 'expanded'
        LIMIT 1`,
      input.scopeId,
      input.profileId
    );
    if (active) {
      throw new EventQuestionKeyRenameConflictError(
        `Question-key rename ${active.operation_id} is already in progress for event profile ${input.profileId}.`
      );
    }
    const activePollReplacement = db.get<{ operation_id: string }>(
      `SELECT replacement.operation_id
         FROM event_poll_replacements replacement
         JOIN event_records event ON event.id = replacement.event_id
        WHERE event.scope_id = ? AND event.profile_id = ?
          AND replacement.status NOT IN ('completed', 'aborted')
        LIMIT 1`,
      input.scopeId,
      input.profileId
    );
    if (activePollReplacement) {
      throw new EventQuestionKeyRenameConflictError(
        `Poll replacement ${activePollReplacement.operation_id} is already in progress for event profile ${input.profileId}.`
      );
    }

    const now = input.createdAt ?? new Date().toISOString();
    const retiredOldRevision = db.get<{ revision: string }>(
      `SELECT revision
         FROM event_profile_retired_revisions
        WHERE scope_id = ? AND profile_id = ? AND revision = ?`,
      input.scopeId,
      input.profileId,
      input.oldProfileRevision
    );
    if (retiredOldRevision) {
      throw new EventQuestionKeyRenameConflictError(
        `Event profile ${input.profileId} is using a retired question schema revision.`
      );
    }
    // The CAS-validated operator config is authoritative. Ordinary profile
    // edits may not have written an event yet, so advance a non-retired fence
    // to the schema from which this rename is starting.
    db.run(
      `INSERT INTO event_profile_revision_fences (
         scope_id, profile_id, current_revision, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope_id, profile_id) DO UPDATE SET
         current_revision = excluded.current_revision,
         updated_at = excluded.updated_at`,
      input.scopeId,
      input.profileId,
      input.oldProfileRevision,
      now
    );

    const rows = db.all<{ id: string; answers_json: string }>(
      `SELECT id, answers_json
         FROM event_records
        WHERE scope_id = ? AND profile_id = ?`,
      input.scopeId,
      input.profileId
    );
    let migratedEventCount = 0;
    for (const row of rows) {
      const answers = parseEventAnswersForQuestionKeyRename(row.id, row.answers_json);
      if (Object.hasOwn(answers, input.newKey)) {
        throw new EventQuestionKeyRenameConflictError(
          Object.hasOwn(answers, input.oldKey)
            ? `Event ${row.id} already contains both ${input.oldKey} and ${input.newKey}; resolve the collision before renaming.`
            : `Event ${row.id} already contains ${input.newKey}; resolve the stored-answer collision before renaming.`
        );
      }
      if (Object.hasOwn(answers, input.oldKey)) {
        migratedEventCount += 1;
      }
    }

    db.run(
      `INSERT INTO event_question_key_renames (
         operation_id, scope_id, profile_id, old_key, new_key,
         old_profile_revision, new_profile_revision, status,
         migrated_event_count, lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'expanded', ?, ?, ?, ?)`,
      input.operationId,
      input.scopeId,
      input.profileId,
      input.oldKey,
      input.newKey,
      input.oldProfileRevision,
      input.newProfileRevision,
      migratedEventCount,
      input.leaseExpiresAt,
      now,
      now
    );

    const oldPath = eventAnswerJsonPath(input.oldKey);
    const newPath = eventAnswerJsonPath(input.newKey);
    db.run(
      `UPDATE event_records
          SET answers_json = json_set(answers_json, ?, json_extract(answers_json, ?)),
              profile_revision = ?
        WHERE scope_id = ?
          AND profile_id = ?
          AND json_type(answers_json, ?) IS NOT NULL`,
      newPath,
      oldPath,
      input.oldProfileRevision,
      input.scopeId,
      input.profileId,
      oldPath
    );

    return eventQuestionKeyRenameFromRow(requireEventQuestionKeyRenameRow(db, input.operationId));
  });
}

export function renewEventQuestionKeyRenameLease(db: PluginDatabase, input: {
  operationId: string;
  leaseExpiresAt: string;
  updatedAt?: string | undefined;
}): boolean {
  const result = db.run(
    `UPDATE event_question_key_renames
        SET lease_expires_at = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'expanded'`,
    input.leaseExpiresAt,
    input.updatedAt ?? new Date().toISOString(),
    input.operationId
  );
  return result.changes === 1;
}

export function listPendingEventQuestionKeyRenames(
  db: PluginDatabase,
  input: { scopeId?: string | undefined; operationId?: string | undefined } = {}
): StoredEventQuestionKeyRename[] {
  const clauses = ["status = 'expanded'"];
  const params: string[] = [];
  if (input.scopeId) {
    clauses.push('scope_id = ?');
    params.push(input.scopeId);
  }
  if (input.operationId) {
    clauses.push('operation_id = ?');
    params.push(input.operationId);
  }
  return db.all<EventQuestionKeyRenameRow>(
    `SELECT *
       FROM event_question_key_renames
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at ASC, operation_id ASC`,
    ...params
  ).map(eventQuestionKeyRenameFromRow);
}

export function settleEventQuestionKeyRename(db: PluginDatabase, input: {
  operationId: string;
  authority: 'old' | 'new';
  authorityRevision: string;
  settledAt?: string | undefined;
}): StoredEventQuestionKeyRename {
  if (!input.authorityRevision.trim()) {
    throw new EventQuestionKeyRenameConflictError('The authoritative event profile revision is required.');
  }
  return db.transaction(() => {
    const row = requireEventQuestionKeyRenameRow(db, input.operationId);
    if (row.status !== 'expanded') {
      return eventQuestionKeyRenameFromRow(row);
    }
    const settledAt = input.settledAt ?? new Date().toISOString();
    const status: EventQuestionKeyRenameStatus = input.authority === 'new' ? 'completed' : 'rolled_back';

    // Disable the dual-write triggers inside this transaction before contracting.
    // The status change and answer contraction commit or roll back together.
    const claimed = db.run(
      `UPDATE event_question_key_renames
          SET status = ?, updated_at = ?
        WHERE operation_id = ? AND status = 'expanded'`,
      status,
      settledAt,
      input.operationId
    );
    if (claimed.changes !== 1) {
      throw new EventQuestionKeyRenameConflictError(
        `Question-key rename ${input.operationId} changed while it was being settled.`
      );
    }

    const oldPath = eventAnswerJsonPath(row.old_key);
    const newPath = eventAnswerJsonPath(row.new_key);
    const authoritativePath = input.authority === 'new' ? newPath : oldPath;
    const discardedPath = input.authority === 'new' ? oldPath : newPath;
    const discardedRevision = input.authority === 'new'
      ? row.old_profile_revision
      : row.new_profile_revision;
    db.run(
      `DELETE FROM event_profile_retired_revisions
        WHERE scope_id = ? AND profile_id = ? AND revision = ?`,
      row.scope_id,
      row.profile_id,
      input.authorityRevision
    );
    if (discardedRevision && discardedRevision !== input.authorityRevision) {
      db.run(
        `INSERT INTO event_profile_retired_revisions (
           scope_id, profile_id, revision, operation_id, retired_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_id, profile_id, revision) DO UPDATE SET
           operation_id = excluded.operation_id,
           retired_at = excluded.retired_at`,
        row.scope_id,
        row.profile_id,
        discardedRevision,
        row.operation_id,
        settledAt
      );
    }
    db.run(
      `INSERT INTO event_profile_revision_fences (
         scope_id, profile_id, current_revision, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope_id, profile_id) DO UPDATE SET
         current_revision = excluded.current_revision,
         updated_at = excluded.updated_at`,
      row.scope_id,
      row.profile_id,
      input.authorityRevision,
      settledAt
    );
    db.run(
      `UPDATE event_records
          SET answers_json = json_remove(
            CASE
              WHEN json_type(answers_json, ?) IS NULL
                   AND json_type(answers_json, ?) IS NOT NULL
                THEN json_set(answers_json, ?, json_extract(answers_json, ?))
              ELSE answers_json
            END,
            ?
          ),
              profile_revision = ?
        WHERE scope_id = ?
          AND profile_id = ?`,
      authoritativePath,
      discardedPath,
      authoritativePath,
      discardedPath,
      discardedPath,
      input.authorityRevision,
      row.scope_id,
      row.profile_id
    );

    return eventQuestionKeyRenameFromRow(requireEventQuestionKeyRenameRow(db, input.operationId));
  });
}

export function insertEvent(
  db: PluginDatabase,
  event: NewStoredEventRecord
): void {
  const actorIdentityId = event.actorIdentityId.trim();
  if (!actorIdentityId) {
    throw new Error('An authoritative actor identity id is required for new event records.');
  }
  const calendarId = event.calendarId?.trim() || null;
  const calendarOwnershipStatus = event.calendarOwnershipStatus;
  const endsAt = event.endsAt ?? new Date(
    new Date(event.startsAt).getTime() + event.calendarDurationMinutes * 60_000
  ).toISOString();
  const lifecycleCompleteAt = event.lifecycleCompleteAt ?? endsAt;
  const spanKind = event.spanKind ?? inferredEventSpanKind(event.calendarDurationMinutes);
  if (
    (calendarOwnershipStatus === 'assigned' && !calendarId) ||
    (calendarOwnershipStatus === 'none' && calendarId !== null)
  ) {
    throw new Error('New event calendar ownership is inconsistent.');
  }
  db.run(
    `INSERT INTO event_records (
      id, scope_id, group_id, group_wid, profile_id, profile_revision, profile_label, origin,
      event_status, group_lifecycle_status, calendar_status, calendar_id, calendar_ownership_status,
      actor_identity_id, actor_wid, actor_label,
      announcement_group_wid, poll_wa_msg_id, poll_generation, poll_question, poll_options_json, response_classes_json,
      answers_json, event_location_json, starts_at, starts_at_utc, ends_at, lifecycle_complete_at, span_kind, timezone, local_date, local_time, place, style,
      close_at, cleanup_at, group_title,
      calendar_duration_minutes, calendar_location, calendar_description, subgroup_chat_id, subgroup_title,
      created_at, updated_at, closed_at, cleaned_at, cancelled_at, cancelled_by_wid, cancelled_by_label,
      cancel_reason, error, provisioning_recovery_generation, provisioning_recovery_attempt,
      provisioning_recovery_next_run_at, provisioning_recovery_halted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.scopeId,
    event.groupId ?? null,
    event.groupWid ?? null,
    event.profileId,
    event.profileRevision,
    event.profileLabel,
    event.origin,
    event.eventStatus,
    event.groupLifecycleStatus,
    event.calendarStatus,
    calendarId,
    calendarOwnershipStatus,
    actorIdentityId,
    event.actorWid,
    event.actorLabel,
    event.announcementGroupWid ?? null,
    event.pollWaMsgId ?? null,
    event.pollGeneration ?? (event.pollWaMsgId ? 1 : 0),
    event.pollQuestion ?? null,
    JSON.stringify(event.pollOptions),
    JSON.stringify(event.responseClasses),
    JSON.stringify(event.answers),
    event.eventLocation ? JSON.stringify(event.eventLocation) : null,
    event.startsAt,
    event.startsAtUtc || event.startsAt,
    endsAt,
    lifecycleCompleteAt,
    spanKind,
    event.timezone,
    event.localDate ?? null,
    event.localTime ?? null,
    event.place ?? null,
    null,
    event.closeAt,
    event.cleanupAt,
    event.groupTitle,
    event.calendarDurationMinutes,
    event.calendarLocation ?? null,
    event.calendarDescription ?? null,
    event.subgroupChatId ?? null,
    event.subgroupTitle ?? null,
    event.createdAt,
    event.updatedAt,
    event.closedAt ?? null,
    event.cleanedAt ?? null,
    event.cancelledAt ?? null,
    event.cancelledByWid ?? null,
    event.cancelledByLabel ?? null,
    event.cancelReason ?? null,
    event.error ?? null,
    event.provisioningRecoveryGeneration ?? null,
    event.provisioningRecoveryAttempt ?? null,
    event.provisioningRecoveryNextRunAt ?? null,
    event.provisioningRecoveryHaltedAt ?? null
  );
}

export function updateEventStructuredData(db: PluginDatabase, input: {
  eventId: string;
  profileRevision: string;
  pollQuestion: string | null;
  pollOptions: StoredEventPollOption[];
  responseClasses: StoredEventResponseClass[];
  answers: Record<string, string>;
  eventLocation?: StoredEventLocation | undefined;
  startsAt: string;
  startsAtUtc: string;
  endsAt?: string | undefined;
  lifecycleCompleteAt?: string | undefined;
  spanKind?: EventSpanKind | undefined;
  timezone: string;
  localDate: string;
  localTime?: string | undefined;
  place?: string | undefined;
  closeAt: string;
  cleanupAt: string;
  groupTitle: string;
  calendarDurationMinutes: number;
  calendarLocation?: string | undefined;
  calendarDescription?: string | undefined;
  expectedUpdatedAt: string;
  updatedAt: string;
  completeEvent?: boolean | undefined;
  announcementIntent?: EventAnnouncementDeliveryIntent | undefined;
  repairIntent?: EventEditRepairIntent | undefined;
}): boolean {
  const endsAt = input.endsAt ?? new Date(
    new Date(input.startsAt).getTime() + input.calendarDurationMinutes * 60_000
  ).toISOString();
  const lifecycleCompleteAt = input.lifecycleCompleteAt ?? endsAt;
  const spanKind = input.spanKind ?? inferredEventSpanKind(input.calendarDurationMinutes);
  return db.transaction(() => {
    const result = db.run(
      `UPDATE event_records
        SET event_status = CASE WHEN ? = 1 THEN 'completed' ELSE event_status END,
            poll_question = ?,
            poll_options_json = ?,
            response_classes_json = ?,
            answers_json = ?,
            profile_revision = ?,
            event_location_json = ?,
            starts_at = ?,
            starts_at_utc = ?,
            ends_at = ?,
            lifecycle_complete_at = ?,
            span_kind = ?,
            timezone = ?,
            local_date = ?,
            local_time = ?,
            place = ?,
            style = ?,
            close_at = ?,
            cleanup_at = ?,
            group_title = ?,
            subgroup_title = CASE WHEN subgroup_chat_id IS NOT NULL THEN ? ELSE subgroup_title END,
            calendar_duration_minutes = ?,
            calendar_location = ?,
            calendar_description = ?,
            updated_at = ?
      WHERE id = ?
        AND updated_at = ?
        AND provisioning_recovery_generation IS NULL
        AND provisioning_recovery_attempt IS NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND (? = 0 OR (event_status = 'active' AND group_lifecycle_status <> 'poll_open'))
        AND NOT EXISTS (
          SELECT 1
            FROM event_cleanup_claims
           WHERE event_cleanup_claims.event_id = event_records.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM event_announcement_delivery_claims
           WHERE event_announcement_delivery_claims.event_id = event_records.id
             AND event_announcement_delivery_claims.kind = 'event_edit'
             AND event_announcement_delivery_claims.status = 'sending'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM event_edit_repairs
           WHERE event_edit_repairs.event_id = event_records.id
             AND event_edit_repairs.status = 'pending'
        )`,
      input.completeEvent ? 1 : 0,
      input.pollQuestion,
      JSON.stringify(input.pollOptions),
      JSON.stringify(input.responseClasses),
      JSON.stringify(input.answers),
      input.profileRevision,
      input.eventLocation ? JSON.stringify(input.eventLocation) : null,
      input.startsAt,
      input.startsAtUtc,
      endsAt,
      lifecycleCompleteAt,
      spanKind,
      input.timezone,
      input.localDate,
      input.localTime ?? null,
      input.place ?? null,
      null,
      input.closeAt,
      input.cleanupAt,
      input.groupTitle,
      input.groupTitle,
      input.calendarDurationMinutes,
      input.calendarLocation ?? null,
      input.calendarDescription ?? null,
      input.updatedAt,
      input.eventId,
      input.expectedUpdatedAt,
      input.completeEvent ? 1 : 0
    );
    if (result.changes !== 1) {
      return false;
    }

    if (input.announcementIntent) {
      const intent = normalizedEventAnnouncementIntent(input.announcementIntent);
      const inserted = db.run(
        `INSERT INTO event_announcement_delivery_claims (
           event_id, kind, delivery_key, scope_id, chat_id, status, text, idempotency_key,
           lease_expires_at, message_id, error, claimed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(event_id, kind, delivery_key) DO NOTHING`,
        input.eventId,
        intent.kind,
        intent.deliveryKey,
        intent.scopeId,
        intent.chatId,
        intent.text,
        intent.idempotencyKey,
        input.updatedAt,
        input.updatedAt
      );
      if (inserted.changes !== 1) {
        throw new Error(
          `Event announcement operation ${intent.deliveryKey} already exists for event ${input.eventId}.`
        );
      }
    }

    if (input.repairIntent) {
      const repair = normalizedEventEditRepairIntent(input.repairIntent);
      const inserted = db.run(
        `INSERT INTO event_edit_repairs (
           operation_id, event_id, scope_id, expected_event_updated_at, subgroup_chat_id,
           target_group_title, calendar_id, announcement_delivery_key,
           calendar_hint_delivery_key, calendar_hint_locale, status, last_error,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)
         ON CONFLICT(operation_id) DO NOTHING`,
        repair.operationId,
        input.eventId,
        repair.scopeId,
        input.updatedAt,
        repair.subgroupChatId ?? null,
        repair.targetGroupTitle,
        repair.calendarId,
        repair.announcementDeliveryKey ?? null,
        repair.calendarHintDeliveryKey ?? null,
        repair.calendarHintLocale ?? null,
        input.updatedAt,
        input.updatedAt
      );
      if (inserted.changes !== 1) {
        throw new Error(`Event edit repair operation ${repair.operationId} already exists.`);
      }
    }
    return true;
  });
}

export function convertOpenPollEventToUnplanned(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  expectedUpdatedAt: string;
  expectedPollWaMsgId: string;
  profileLabel: string;
  profileRevision: string;
  responseClasses: StoredEventResponseClass[];
  answers: Record<string, string>;
  eventLocation?: StoredEventLocation | undefined;
  startsAt: string;
  startsAtUtc: string;
  endsAt: string;
  lifecycleCompleteAt?: string | undefined;
  spanKind: EventSpanKind;
  timezone: string;
  localDate: string;
  localTime?: string | undefined;
  place?: string | undefined;
  closeAt: string;
  cleanupAt: string;
  groupTitle: string;
  calendarDurationMinutes: number;
  calendarLocation?: string | undefined;
  calendarDescription?: string | undefined;
  provisioningGeneration: string;
  provisioningAttempt: number;
  provisioningNextRunAt: string;
  updatedAt: string;
}): boolean {
  return db.transaction(() => {
    const result = db.run(
      `UPDATE event_records
          SET profile_label = ?, profile_revision = ?, origin = 'unplanned',
              event_status = 'failed', group_lifecycle_status = 'none', calendar_status = 'hidden',
              poll_wa_msg_id = NULL, poll_generation = poll_generation + 1, poll_question = NULL,
              poll_options_json = '[]', response_classes_json = ?, answers_json = ?,
              event_location_json = ?, starts_at = ?, starts_at_utc = ?, ends_at = ?, lifecycle_complete_at = ?, span_kind = ?,
              timezone = ?, local_date = ?, local_time = ?, place = ?, style = NULL,
              close_at = ?, cleanup_at = ?, group_title = ?, calendar_duration_minutes = ?,
              calendar_location = ?, calendar_description = ?, closed_at = NULL, error = NULL,
              provisioning_recovery_generation = ?, provisioning_recovery_attempt = ?,
              provisioning_recovery_next_run_at = ?, provisioning_recovery_halted_at = NULL,
              updated_at = ?
        WHERE id = ? AND scope_id = ?
          AND event_status = 'active' AND group_lifecycle_status = 'poll_open'
          AND updated_at = ? AND poll_wa_msg_id = ?
          AND cleanup_at > ?
          AND subgroup_chat_id IS NULL
          AND provisioning_recovery_generation IS NULL
          AND provisioning_recovery_attempt IS NULL
          AND provisioning_recovery_next_run_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM event_poll_replacements
             WHERE event_poll_replacements.event_id = event_records.id
               AND event_poll_replacements.status NOT IN ('completed', 'aborted')
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_announcement_delivery_claims
             WHERE event_announcement_delivery_claims.event_id = event_records.id
               AND event_announcement_delivery_claims.status = 'sending'
          )`,
      input.profileLabel,
      input.profileRevision,
      JSON.stringify(input.responseClasses),
      JSON.stringify(input.answers),
      input.eventLocation ? JSON.stringify(input.eventLocation) : null,
      input.startsAt,
      input.startsAtUtc,
      input.endsAt,
      input.lifecycleCompleteAt ?? input.endsAt,
      input.spanKind,
      input.timezone,
      input.localDate,
      input.localTime ?? null,
      input.place ?? null,
      input.closeAt,
      input.cleanupAt,
      input.groupTitle,
      input.calendarDurationMinutes,
      input.calendarLocation ?? null,
      input.calendarDescription ?? null,
      input.provisioningGeneration,
      input.provisioningAttempt,
      input.provisioningNextRunAt,
      input.updatedAt,
      input.eventId,
      input.scopeId,
      input.expectedUpdatedAt,
      input.expectedPollWaMsgId,
      input.updatedAt
    );
    if (result.changes !== 1) {
      return false;
    }
    db.run('DELETE FROM event_votes WHERE event_id = ?', input.eventId);
    db.run(
      `UPDATE event_announcement_delivery_claims
          SET status = 'superseded', lease_expires_at = NULL, updated_at = ?
        WHERE event_id = ? AND status IN ('pending', 'uncertain')`,
      input.updatedAt,
      input.eventId
    );
    return true;
  });
}

export function updateEventSubgroupTitle(db: PluginDatabase, input: {
  eventId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  updatedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET subgroup_title = ?, updated_at = ?
      WHERE id = ?
        AND subgroup_chat_id = ?
        AND origin = 'adopted_group'
        AND event_status = 'active'
        AND group_lifecycle_status = 'poll_closed'
        AND subgroup_title IS NULL`,
    input.subgroupTitle,
    input.updatedAt,
    input.eventId,
    input.subgroupChatId
  );
  return result.changes === 1;
}

export function getEvent(db: PluginDatabase, eventId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>('SELECT * FROM event_records WHERE id = ?', eventId);
  return row ? eventFromRow(row) : undefined;
}

export function beginEventPollReplacement(db: PluginDatabase, input: {
  operationId: string;
  eventId: string;
  scopeId: string;
  expectedEventUpdatedAt: string;
  expectedPollWaMsgId: string;
  expectedPollGeneration: number;
  target: EventPollReplacementTarget;
  editorIdentityId: string;
  editorWid: string;
  editorLabel: string;
  locale: string;
  sourcePluginId: string;
  publishIdempotencyKey: string;
  createdAt?: string | undefined;
}): StoredEventPollReplacement {
  return db.transaction(() => {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const existing = db.get<EventPollReplacementRow>(
      'SELECT * FROM event_poll_replacements WHERE operation_id = ?',
      input.operationId
    );
    if (existing) {
      if (existing.event_id !== input.eventId || existing.scope_id !== input.scopeId) {
        throw new EventPollReplacementConflictError(
          `Event poll replacement operation ${input.operationId} belongs to another event.`
        );
      }
      return eventPollReplacementFromRow(existing);
    }

    const event = db.get<EventRow>(
      `SELECT * FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND event_status = 'active'
          AND group_lifecycle_status = 'poll_open'
          AND updated_at = ?
          AND poll_wa_msg_id = ?
          AND poll_generation = ?
          AND provisioning_recovery_generation IS NULL
          AND provisioning_recovery_attempt IS NULL
          AND provisioning_recovery_next_run_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM event_poll_replacements replacement
             WHERE replacement.event_id = event_records.id
               AND replacement.status NOT IN ('completed', 'aborted')
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_announcement_delivery_claims delivery
             WHERE delivery.event_id = event_records.id
               AND delivery.status = 'sending'
               AND delivery.lease_expires_at > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_edit_repairs repair
             WHERE repair.event_id = event_records.id
               AND repair.status = 'pending'
               AND repair.subgroup_chat_id IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_edit_repairs repair
             WHERE repair.event_id = event_records.id
               AND repair.status = 'pending'
               AND repair.execution_claim_id IS NOT NULL
               AND repair.execution_lease_expires_at > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_question_key_renames rename
             WHERE rename.scope_id = event_records.scope_id
               AND rename.profile_id = event_records.profile_id
               AND rename.status = 'expanded'
          )`,
      input.eventId,
      input.scopeId,
      input.expectedEventUpdatedAt,
      input.expectedPollWaMsgId,
      input.expectedPollGeneration,
      createdAt,
      createdAt
    );
    if (!event) {
      throw new EventPollReplacementConflictError(
        `Event ${input.eventId} changed before its poll replacement could begin.`
      );
    }
    const persistedPollArtifact = db.get<{ id: string }>(
      `SELECT id FROM event_announcement_messages
        WHERE event_id = ? AND kind = 'poll' AND message_id = ?
        LIMIT 1`,
      input.eventId,
      input.expectedPollWaMsgId
    );
    if (!persistedPollArtifact) {
      db.run(
        `INSERT INTO event_announcement_messages (
           id, event_id, scope_id, kind, delivery_key, chat_id, message_id,
           created_at, deleted_at, delete_error
         ) VALUES (?, ?, ?, 'poll', ?, ?, ?, ?, NULL, NULL)`,
        `evtmsg-${randomUUID()}`,
        input.eventId,
        input.scopeId,
        `replacement-source:${input.operationId}`,
        event.announcement_group_wid ?? event.group_wid ?? '',
        input.expectedPollWaMsgId,
        createdAt
      );
    }
    const artifactIds = db.all<{ id: string }>(
      `SELECT id FROM event_announcement_messages
        WHERE event_id = ? AND scope_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
      input.eventId,
      input.scopeId
    ).map((row) => row.id);
    const now = createdAt;
    db.run(
      `INSERT INTO event_poll_replacements (
         operation_id, event_id, scope_id, status, expected_event_updated_at,
         old_poll_wa_msg_id, old_poll_generation, target_json,
         editor_identity_id, editor_wid, editor_label, locale, source_plugin_id,
         artifact_ids_json, publish_idempotency_key, new_poll_wa_msg_id,
         publication_claim_token, publication_lease_expires_at, publication_started_at,
         failure_count, next_attempt_at, last_error, created_at, updated_at,
         published_at, swapped_at, completed_at, retired_at, retirement_error,
         retirement_failure_count, receipt_released_at, receipt_release_error,
         receipt_release_failure_count, receipt_release_next_attempt_at
       ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                 0, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, 0,
                 NULL, NULL, 0, NULL)`,
      input.operationId,
      input.eventId,
      input.scopeId,
      input.expectedEventUpdatedAt,
      input.expectedPollWaMsgId,
      input.expectedPollGeneration,
      JSON.stringify(input.target),
      input.editorIdentityId,
      input.editorWid,
      input.editorLabel,
      input.locale,
      input.sourcePluginId,
      JSON.stringify(artifactIds),
      input.publishIdempotencyKey,
      now,
      now
    );
    return requireEventPollReplacement(db, input.operationId);
  });
}

export function getEventPollReplacement(
  db: PluginDatabase,
  operationId: string
): StoredEventPollReplacement | undefined {
  const row = db.get<EventPollReplacementRow>(
    'SELECT * FROM event_poll_replacements WHERE operation_id = ?',
    operationId
  );
  return row ? eventPollReplacementFromRow(row) : undefined;
}

export function listPendingEventPollReplacements(
  db: PluginDatabase,
  now: Date = new Date()
): StoredEventPollReplacement[] {
  return db.all<EventPollReplacementRow>(
    `SELECT * FROM event_poll_replacements
      WHERE (status = 'published' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (status = 'pending' AND (
           (publication_claim_token IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           OR (publication_claim_token IS NOT NULL
             AND publication_lease_expires_at <= ?)
         ))
      ORDER BY created_at ASC, operation_id ASC`,
    now.toISOString(),
    now.toISOString(),
    now.toISOString()
  ).map(eventPollReplacementFromRow);
}

export function hasActiveEventPollReplacement(db: PluginDatabase, eventId: string): boolean {
  return Boolean(db.get<{ operation_id: string }>(
    `SELECT operation_id FROM event_poll_replacements
      WHERE event_id = ? AND status NOT IN ('completed', 'aborted')
      LIMIT 1`,
    eventId
  ));
}

export function claimEventPollReplacementPublication(db: PluginDatabase, input: {
  operationId: string;
  claimToken: string;
  now: string;
  leaseExpiresAt: string;
}): StoredEventPollReplacement | undefined {
  if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
    throw new Error('Event poll replacement publication lease must expire after it starts.');
  }
  const changed = db.run(
    `UPDATE event_poll_replacements
        SET publication_claim_token = ?, publication_lease_expires_at = ?,
            next_attempt_at = NULL, updated_at = ?
      WHERE operation_id = ? AND status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (
          publication_claim_token IS NULL
          OR publication_lease_expires_at <= ?
        )`,
    input.claimToken,
    input.leaseExpiresAt,
    input.now,
    input.operationId,
    input.now,
    input.now
  ).changes;
  return changed === 1 ? requireEventPollReplacement(db, input.operationId) : undefined;
}

/** An expired claim is never revived at the provider mutation boundary. */
export function renewEventPollReplacementPublicationClaim(db: PluginDatabase, input: {
  claim: EventPollReplacementPublicationClaim;
  now: string;
  leaseExpiresAt: string;
}): boolean {
  if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
    throw new Error('Renewed event poll replacement lease must expire after renewal.');
  }
  return db.run(
    `UPDATE event_poll_replacements
        SET publication_lease_expires_at = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'pending'
        AND publication_claim_token = ?
        AND publication_lease_expires_at > ?`,
    input.leaseExpiresAt,
    input.now,
    input.claim.operationId,
    input.claim.claimToken,
    input.now
  ).changes === 1;
}

/**
 * Persists the provider-attempt anchor under the current publication claim.
 * DOAS/whatsmeow still owns cross-process provider idempotency; the local lease
 * prevents two plugin runners from concurrently reconciling or invoking it.
 */
export function markEventPollReplacementPublicationStarted(db: PluginDatabase, input: {
  operationId: string;
  claimToken: string;
  startedAt?: string | undefined;
}): StoredEventPollReplacement | undefined {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const changed = db.run(
    `UPDATE event_poll_replacements
        SET publication_started_at = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'pending'
        AND publication_claim_token = ? AND publication_lease_expires_at > ?
        AND publication_started_at IS NULL`,
    startedAt,
    startedAt,
    input.operationId,
    input.claimToken,
    startedAt
  ).changes;
  return changed === 1 ? requireEventPollReplacement(db, input.operationId) : undefined;
}

/** Clears only the exact attempt anchor whose provider call proved non-delivery. */
export function clearEventPollReplacementPublicationStarted(db: PluginDatabase, input: {
  operationId: string;
  claimToken: string;
  expectedStartedAt: string;
  clearedAt?: string | undefined;
}): { replacement: StoredEventPollReplacement; cleared: boolean } {
  const clearedAt = input.clearedAt ?? new Date().toISOString();
  const changed = db.run(
    `UPDATE event_poll_replacements
        SET publication_started_at = NULL, updated_at = ?
      WHERE operation_id = ? AND status = 'pending'
        AND publication_claim_token = ? AND publication_lease_expires_at > ?
        AND publication_started_at = ?`,
    clearedAt,
    input.operationId,
    input.claimToken,
    clearedAt,
    input.expectedStartedAt
  ).changes;
  return {
    replacement: requireEventPollReplacement(db, input.operationId),
    cleared: changed === 1
  };
}

/**
 * A deadline can safely abort without provider reconciliation only while no
 * durable provider-attempt anchor exists. The NULL predicate is the CAS that
 * races the pre-publish anchor.
 */
export function abortUnstartedEventPollReplacement(db: PluginDatabase, input: {
  operationId: string;
  claimToken: string;
  reason: string;
  abortedAt?: string | undefined;
}): { replacement: StoredEventPollReplacement; aborted: boolean } {
  const abortedAt = input.abortedAt ?? new Date().toISOString();
  const changed = db.run(
    `UPDATE event_poll_replacements
        SET status = 'aborted', artifact_ids_json = '[]', last_error = ?,
            publication_claim_token = NULL, publication_lease_expires_at = NULL,
            next_attempt_at = NULL, updated_at = ?, completed_at = ?, retired_at = ?
      WHERE operation_id = ? AND status = 'pending' AND publication_started_at IS NULL
        AND publication_claim_token = ? AND publication_lease_expires_at > ?`,
    input.reason,
    abortedAt,
    abortedAt,
    abortedAt,
    input.operationId,
    input.claimToken,
    abortedAt
  ).changes;
  return {
    replacement: requireEventPollReplacement(db, input.operationId),
    aborted: changed === 1
  };
}

export function markEventPollReplacementPublished(db: PluginDatabase, input: {
  operationId: string;
  messageId: string;
  publishedAt?: string | undefined;
}): StoredEventPollReplacement {
  return db.transaction(() => {
    const replacement = requireEventPollReplacement(db, input.operationId);
    if (replacement.newPollWaMsgId && replacement.newPollWaMsgId !== input.messageId) {
      throw new EventPollReplacementConflictError(
        `Event poll replacement ${input.operationId} received conflicting publication receipts.`
      );
    }
    const checkpointArtifact = (publishedAt: string): StoredEventAnnouncementMessage => {
      const event = getEvent(db, replacement.eventId);
      const chatId = event?.announcementGroupWid?.trim() || event?.groupWid?.trim();
      if (!event || !chatId) {
        throw new EventPollReplacementConflictError(
          `Event ${replacement.eventId} lost its announcement group while its replacement receipt was persisted.`
        );
      }
      return recordEventAnnouncementMessage(db, {
        eventId: replacement.eventId,
        scopeId: replacement.scopeId,
        kind: 'poll',
        deliveryKey: replacement.operationId,
        chatId,
        messageId: input.messageId,
        createdAt: publishedAt
      });
    };
    if (replacement.status === 'aborted') {
      if (replacement.newPollWaMsgId === input.messageId) {
        return replacement;
      }
      const publishedAt = input.publishedAt ?? new Date().toISOString();
      const artifact = checkpointArtifact(publishedAt);
      db.run(
        `UPDATE event_poll_replacements
            SET new_poll_wa_msg_id = ?, published_at = ?,
                publication_started_at = COALESCE(publication_started_at, ?), artifact_ids_json = ?,
                retired_at = NULL, retirement_error = NULL,
                publication_claim_token = NULL, publication_lease_expires_at = NULL,
                next_attempt_at = NULL, updated_at = ?
          WHERE operation_id = ? AND status = 'aborted' AND new_poll_wa_msg_id IS NULL`,
        input.messageId,
        publishedAt,
        publishedAt,
        JSON.stringify([artifact.id]),
        publishedAt,
        input.operationId
      );
      return requireEventPollReplacement(db, input.operationId);
    }
    if (replacement.status !== 'pending') {
      return replacement;
    }
    const publishedAt = input.publishedAt ?? new Date().toISOString();
    const changed = db.run(
      `UPDATE event_poll_replacements
          SET status = 'published', new_poll_wa_msg_id = ?, published_at = ?,
              publication_started_at = COALESCE(publication_started_at, ?),
              publication_claim_token = NULL, publication_lease_expires_at = NULL,
              next_attempt_at = NULL, last_error = NULL, updated_at = ?
        WHERE operation_id = ? AND status = 'pending'`,
      input.messageId,
      publishedAt,
      publishedAt,
      publishedAt,
      input.operationId
    ).changes;
    if (changed !== 1) {
      throw new EventPollReplacementConflictError(
        `Event poll replacement ${input.operationId} changed while its receipt was persisted.`
      );
    }
    checkpointArtifact(publishedAt);
    return requireEventPollReplacement(db, input.operationId);
  });
}

export function swapPublishedEventPollReplacement(db: PluginDatabase, input: {
  operationId: string;
  swappedAt?: string | undefined;
}): { replacement: StoredEventPollReplacement; event: StoredEventRecord } {
  return db.transaction(() => {
    const replacement = requireEventPollReplacement(db, input.operationId);
    const existingEvent = getEvent(db, replacement.eventId);
    if (!existingEvent) {
      throw new EventPollReplacementConflictError(
        `Event ${replacement.eventId} disappeared during poll replacement.`
      );
    }
    if (replacement.status === 'completed') {
      return { replacement, event: existingEvent };
    }
    if (replacement.status !== 'published' || !replacement.newPollWaMsgId) {
      throw new EventPollReplacementConflictError(
        `Event poll replacement ${replacement.operationId} has not been published.`
      );
    }
    const target = replacement.target;
    const targetEndsAt = target.endsAt ?? new Date(
      new Date(target.startsAt).getTime() + target.calendarDurationMinutes * 60_000
    ).toISOString();
    const targetLifecycleCompleteAt = target.lifecycleCompleteAt ?? targetEndsAt;
    const targetSpanKind = target.spanKind ?? inferredEventSpanKind(target.calendarDurationMinutes);
    const swappedAt = nextEventRevisionTimestamp(
      replacement.expectedEventUpdatedAt,
      input.swappedAt ? new Date(input.swappedAt) : new Date()
    );
    let changed: number;
    try {
      changed = db.run(
        `UPDATE event_records
          SET profile_label = ?, profile_revision = ?, poll_wa_msg_id = ?,
              poll_generation = ?, poll_question = ?, poll_options_json = ?,
              response_classes_json = ?, answers_json = ?, event_location_json = ?,
              starts_at = ?, starts_at_utc = ?, timezone = ?, local_date = ?,
              ends_at = ?, lifecycle_complete_at = ?, span_kind = ?,
              local_time = ?, place = ?, style = NULL, close_at = ?, cleanup_at = ?,
              group_title = ?,
              subgroup_title = CASE WHEN subgroup_chat_id IS NOT NULL THEN ? ELSE subgroup_title END,
              calendar_duration_minutes = ?, calendar_location = ?,
              calendar_description = ?, error = NULL, updated_at = ?
        WHERE id = ? AND scope_id = ?
          AND event_status = 'active' AND group_lifecycle_status = 'poll_open'
          AND updated_at = ? AND poll_wa_msg_id = ? AND poll_generation = ?
          AND provisioning_recovery_generation IS NULL
          AND provisioning_recovery_attempt IS NULL
          AND provisioning_recovery_next_run_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM event_cleanup_claims
             WHERE event_cleanup_claims.event_id = event_records.id
          )`,
      target.profileLabel,
      target.profileRevision,
      replacement.newPollWaMsgId,
      replacement.oldPollGeneration + 1,
      target.pollQuestion,
      JSON.stringify(target.pollOptions),
      JSON.stringify(target.responseClasses),
      JSON.stringify(target.answers),
      target.eventLocation ? JSON.stringify(target.eventLocation) : null,
      target.startsAt,
      target.startsAtUtc,
      target.timezone,
      target.localDate,
      targetEndsAt,
      targetLifecycleCompleteAt,
      targetSpanKind,
      target.localTime ?? null,
      target.place ?? null,
      target.closeAt,
      target.cleanupAt,
      target.groupTitle,
      target.groupTitle,
      target.calendarDurationMinutes,
      target.calendarLocation ?? null,
      target.calendarDescription ?? null,
      swappedAt,
      replacement.eventId,
      replacement.scopeId,
      replacement.expectedEventUpdatedAt,
      replacement.oldPollWaMsgId,
        replacement.oldPollGeneration
      ).changes;
    } catch (error) {
      const sqliteCode = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
      if (sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
        throw new EventPollReplacementConflictError(
          `Event ${replacement.eventId} rejected its published replacement: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      throw error;
    }
    if (changed !== 1) {
      throw new EventPollReplacementConflictError(
        `Event ${replacement.eventId} changed before its replacement poll could be activated.`
      );
    }
    db.run('DELETE FROM event_votes WHERE event_id = ?', replacement.eventId);
    recordEventAnnouncementMessage(db, {
      eventId: replacement.eventId,
      scopeId: replacement.scopeId,
      kind: 'poll',
      deliveryKey: replacement.operationId,
      chatId: existingEvent.announcementGroupWid ?? existingEvent.groupWid ?? '',
      messageId: replacement.newPollWaMsgId,
      createdAt: swappedAt
    });
    const announcementIntent = target.announcementIntent
      ? normalizedEventAnnouncementIntent(target.announcementIntent)
      : undefined;
    const repairIntent = normalizedEventEditRepairIntent(target.repairIntent ?? {
      operationId: replacement.operationId,
      scopeId: replacement.scopeId,
      ...(existingEvent.subgroupChatId ? { subgroupChatId: existingEvent.subgroupChatId } : {}),
      targetGroupTitle: target.groupTitle,
      calendarId: resolvedEventCalendarId(existingEvent) ?? ''
    });
    if (
      repairIntent.operationId !== replacement.operationId ||
      repairIntent.scopeId !== replacement.scopeId ||
      Boolean(announcementIntent) !== Boolean(repairIntent.announcementDeliveryKey) ||
      (announcementIntent && (
        announcementIntent.scopeId !== replacement.scopeId ||
        announcementIntent.kind !== 'event_edit' ||
        announcementIntent.deliveryKey !== repairIntent.announcementDeliveryKey
      ))
    ) {
      throw new EventPollReplacementConflictError(
        `Event poll replacement ${replacement.operationId} has invalid presentation intent.`
      );
    }
    if (announcementIntent) {
      const inserted = db.run(
        `INSERT INTO event_announcement_delivery_claims (
           event_id, kind, delivery_key, scope_id, chat_id, status, text, idempotency_key,
           lease_expires_at, message_id, error, claimed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(event_id, kind, delivery_key) DO NOTHING`,
        replacement.eventId,
        announcementIntent.kind,
        announcementIntent.deliveryKey,
        announcementIntent.scopeId,
        announcementIntent.chatId,
        announcementIntent.text,
        announcementIntent.idempotencyKey,
        swappedAt,
        swappedAt
      );
      if (inserted.changes !== 1) {
        throw new EventPollReplacementConflictError(
          `Event announcement operation ${announcementIntent.deliveryKey} already exists for event ${replacement.eventId}.`
        );
      }
    }
    const insertedRepair = db.run(
      `INSERT INTO event_edit_repairs (
         operation_id, event_id, scope_id, expected_event_updated_at, subgroup_chat_id,
         target_group_title, calendar_id, announcement_delivery_key,
         calendar_hint_delivery_key, calendar_hint_locale, status, last_error,
         created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)
       ON CONFLICT(operation_id) DO NOTHING`,
      repairIntent.operationId,
      replacement.eventId,
      repairIntent.scopeId,
      swappedAt,
      repairIntent.subgroupChatId ?? null,
      repairIntent.targetGroupTitle,
      repairIntent.calendarId,
      repairIntent.announcementDeliveryKey ?? null,
      repairIntent.calendarHintDeliveryKey ?? null,
      repairIntent.calendarHintLocale ?? null,
      swappedAt,
      swappedAt
    );
    if (insertedRepair.changes !== 1) {
      throw new EventPollReplacementConflictError(
        `Event edit repair operation ${repairIntent.operationId} already exists.`
      );
    }
    db.run(
      `UPDATE event_poll_replacements
          SET status = 'completed', swapped_at = ?, completed_at = ?,
              publication_claim_token = NULL, publication_lease_expires_at = NULL,
              next_attempt_at = NULL, last_error = NULL, updated_at = ?
        WHERE operation_id = ? AND status = 'published'`,
      swappedAt,
      swappedAt,
      swappedAt,
      replacement.operationId
    );
    appendEventLog(db, {
      eventId: replacement.eventId,
      action: 'events.poll_replacement.swapped',
      metadata: {
        operationId: replacement.operationId,
        oldPollWaMsgId: replacement.oldPollWaMsgId,
        newPollWaMsgId: replacement.newPollWaMsgId,
        oldPollGeneration: replacement.oldPollGeneration,
        pollGeneration: replacement.oldPollGeneration + 1
      }
    });
    return {
      replacement: requireEventPollReplacement(db, replacement.operationId),
      event: getEvent(db, replacement.eventId)!
    };
  });
}

export function failEventPollReplacement(db: PluginDatabase, input: {
  operationId: string;
  claimToken?: string | undefined;
  reason: string;
  nextAttemptAt: string;
  failedAt?: string | undefined;
}): { replacement: StoredEventPollReplacement; failed: boolean } {
  const failedAt = input.failedAt ?? new Date().toISOString();
  const changed = input.claimToken
    ? db.run(
        `UPDATE event_poll_replacements
            SET publication_claim_token = NULL, publication_lease_expires_at = NULL,
                failure_count = failure_count + 1, next_attempt_at = ?, last_error = ?, updated_at = ?
          WHERE operation_id = ? AND status = 'pending' AND publication_claim_token = ?`,
        input.nextAttemptAt,
        input.reason,
        failedAt,
        input.operationId,
        input.claimToken
      ).changes
    : db.run(
        `UPDATE event_poll_replacements
            SET failure_count = failure_count + 1, next_attempt_at = ?, last_error = ?, updated_at = ?
          WHERE operation_id = ? AND status = 'published'`,
        input.nextAttemptAt,
        input.reason,
        failedAt,
        input.operationId
      ).changes;
  return {
    replacement: requireEventPollReplacement(db, input.operationId),
    failed: changed === 1
  };
}

/**
 * A definite non-delivery may remove only the exact anchor established by the
 * still-current claimant. If a successor has taken the lease, this is a no-op.
 */
export function resetEventPollReplacementAfterDefiniteNonDelivery(
  db: PluginDatabase,
  input: {
    operationId: string;
    claimToken: string;
    expectedStartedAt: string;
    reason: string;
    nextAttemptAt: string;
    failedAt?: string | undefined;
  }
): { replacement: StoredEventPollReplacement; reset: boolean } {
  const failedAt = input.failedAt ?? new Date().toISOString();
  const changed = db.run(
    `UPDATE event_poll_replacements
        SET publication_claim_token = NULL, publication_lease_expires_at = NULL,
            publication_started_at = NULL, failure_count = failure_count + 1,
            next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'pending'
        AND publication_claim_token = ? AND publication_started_at = ?`,
    input.nextAttemptAt,
    input.reason,
    failedAt,
    input.operationId,
    input.claimToken,
    input.expectedStartedAt
  ).changes;
  return {
    replacement: requireEventPollReplacement(db, input.operationId),
    reset: changed === 1
  };
}

export function abortEventPollReplacement(db: PluginDatabase, input: {
  operationId: string;
  reason: string;
  abortedAt?: string | undefined;
}): StoredEventPollReplacement {
  const abortedAt = input.abortedAt ?? new Date().toISOString();
  db.run(
      `UPDATE event_poll_replacements
        SET status = 'aborted', artifact_ids_json = '[]', last_error = ?,
            publication_claim_token = NULL, publication_lease_expires_at = NULL,
            next_attempt_at = NULL, updated_at = ?, completed_at = ?, retired_at = ?
      WHERE operation_id = ? AND status = 'pending'`,
    input.reason,
    abortedAt,
    abortedAt,
    abortedAt,
    input.operationId
  );
  return requireEventPollReplacement(db, input.operationId);
}

/**
 * Permanently abandons a poll that was published but could not win the event
 * revision CAS. The replacement poll artifact becomes the only retirement
 * target; the still-authoritative old event artifacts must remain untouched.
 */
export function abortPublishedEventPollReplacement(db: PluginDatabase, input: {
  operationId: string;
  reason: string;
  abortedAt?: string | undefined;
}): StoredEventPollReplacement {
  return db.transaction(() => {
    const replacement = requireEventPollReplacement(db, input.operationId);
    if (replacement.status === 'aborted') {
      return replacement;
    }
    if (replacement.status !== 'published' || !replacement.newPollWaMsgId) {
      throw new EventPollReplacementConflictError(
        `Event poll replacement ${input.operationId} has no published poll to abandon.`
      );
    }
    const artifact = db.get<{ id: string }>(
      `SELECT id FROM event_announcement_messages
        WHERE event_id = ? AND kind = 'poll' AND delivery_key = ?
        LIMIT 1`,
      replacement.eventId,
      replacement.operationId
    );
    if (!artifact) {
      throw new EventPollReplacementConflictError(
        `Event poll replacement ${input.operationId} lost its published artifact checkpoint.`
      );
    }
    const abortedAt = input.abortedAt ?? new Date().toISOString();
    const changed = db.run(
      `UPDATE event_poll_replacements
          SET status = 'aborted', artifact_ids_json = ?, last_error = ?,
              publication_claim_token = NULL, publication_lease_expires_at = NULL,
              next_attempt_at = NULL, updated_at = ?, completed_at = ?
        WHERE operation_id = ? AND status = 'published'`,
      JSON.stringify([artifact.id]),
      input.reason,
      abortedAt,
      abortedAt,
      input.operationId
    ).changes;
    if (changed !== 1) {
      throw new EventPollReplacementConflictError(
        `Event poll replacement ${input.operationId} changed while it was being abandoned.`
      );
    }
    appendEventLog(db, {
      eventId: replacement.eventId,
      action: 'events.poll_replacement.aborted_after_publish',
      metadata: {
        operationId: replacement.operationId,
        oldPollWaMsgId: replacement.oldPollWaMsgId,
        publishedPollWaMsgId: replacement.newPollWaMsgId,
        reason: input.reason
      }
    });
    return requireEventPollReplacement(db, input.operationId);
  });
}

export function markEventPollReplacementRetired(db: PluginDatabase, input: {
  operationId: string;
  retiredAt?: string | undefined;
}): StoredEventPollReplacement {
  const retiredAt = input.retiredAt ?? new Date().toISOString();
  db.run(
    `UPDATE event_poll_replacements
        SET retired_at = ?, retirement_error = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE operation_id = ? AND status IN ('completed', 'aborted') AND retired_at IS NULL`,
    retiredAt,
    retiredAt,
    input.operationId
  );
  return requireEventPollReplacement(db, input.operationId);
}

export function markEventPollReplacementRetirementFailed(db: PluginDatabase, input: {
  operationId: string;
  reason: string;
  nextAttemptAt: string;
  failedAt?: string | undefined;
}): StoredEventPollReplacement {
  const failedAt = input.failedAt ?? new Date().toISOString();
  db.run(
    `UPDATE event_poll_replacements
        SET retirement_error = ?, retirement_failure_count = retirement_failure_count + 1,
            next_attempt_at = ?, updated_at = ?
      WHERE operation_id = ? AND status IN ('completed', 'aborted') AND retired_at IS NULL`,
    input.reason,
    input.nextAttemptAt,
    failedAt,
    input.operationId
  );
  return requireEventPollReplacement(db, input.operationId);
}

export function listPendingEventPollReplacementRetirements(
  db: PluginDatabase,
  now: Date = new Date()
): StoredEventPollReplacement[] {
  return db.all<EventPollReplacementRow>(
    `SELECT * FROM event_poll_replacements
      WHERE status IN ('completed', 'aborted') AND new_poll_wa_msg_id IS NOT NULL
        AND retired_at IS NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY completed_at ASC, operation_id ASC`,
    now.toISOString()
  ).map(eventPollReplacementFromRow);
}

export function markEventPollReplacementReceiptReleased(db: PluginDatabase, input: {
  operationId: string;
  releasedAt?: string | undefined;
}): StoredEventPollReplacement {
  const releasedAt = input.releasedAt ?? new Date().toISOString();
  db.run(
    `UPDATE event_poll_replacements
        SET receipt_released_at = ?, receipt_release_error = NULL,
            receipt_release_next_attempt_at = NULL, updated_at = ?
      WHERE operation_id = ? AND status IN ('completed', 'aborted')
        AND new_poll_wa_msg_id IS NOT NULL AND receipt_released_at IS NULL`,
    releasedAt,
    releasedAt,
    input.operationId
  );
  return requireEventPollReplacement(db, input.operationId);
}

export function markEventPollReplacementReceiptReleaseFailed(db: PluginDatabase, input: {
  operationId: string;
  reason: string;
  nextAttemptAt: string;
  failedAt?: string | undefined;
}): StoredEventPollReplacement {
  const failedAt = input.failedAt ?? new Date().toISOString();
  db.run(
    `UPDATE event_poll_replacements
        SET receipt_release_error = ?,
            receipt_release_failure_count = receipt_release_failure_count + 1,
            receipt_release_next_attempt_at = ?, updated_at = ?
      WHERE operation_id = ? AND status IN ('completed', 'aborted')
        AND new_poll_wa_msg_id IS NOT NULL AND receipt_released_at IS NULL`,
    input.reason,
    input.nextAttemptAt,
    failedAt,
    input.operationId
  );
  return requireEventPollReplacement(db, input.operationId);
}

/** A replacement receipt can be released only once its poll is not authoritative. */
export function eventPollReplacementReceiptReleaseEligible(
  db: PluginDatabase,
  replacement: StoredEventPollReplacement
): boolean {
  if (
    !replacement.newPollWaMsgId ||
    replacement.receiptReleasedAt ||
    (replacement.status !== 'completed' && replacement.status !== 'aborted')
  ) {
    return false;
  }
  if (replacement.status === 'aborted') {
    return true;
  }
  const event = getEvent(db, replacement.eventId);
  if (!event) {
    return true;
  }
  const replacementGeneration = replacement.oldPollGeneration + 1;
  return event.eventStatus !== 'active' ||
    event.groupLifecycleStatus !== 'poll_open' ||
    event.pollGeneration !== replacementGeneration ||
    event.pollWaMsgId !== replacement.newPollWaMsgId;
}

export function listEligibleEventPollReplacementReceiptReleases(
  db: PluginDatabase,
  now: Date = new Date(),
  eventId?: string | undefined
): StoredEventPollReplacement[] {
  return db.all<EventPollReplacementRow>(
    `SELECT replacement.*
       FROM event_poll_replacements replacement
      WHERE replacement.status IN ('completed', 'aborted')
        AND replacement.new_poll_wa_msg_id IS NOT NULL
        AND replacement.receipt_released_at IS NULL
        AND (replacement.receipt_release_next_attempt_at IS NULL
          OR replacement.receipt_release_next_attempt_at <= ?)
        AND (? IS NULL OR replacement.event_id = ?)
      ORDER BY replacement.completed_at ASC, replacement.operation_id ASC`,
    now.toISOString(),
    eventId ?? null,
    eventId ?? null
  ).map(eventPollReplacementFromRow)
    .filter((replacement) => eventPollReplacementReceiptReleaseEligible(db, replacement));
}

export function getEventByPoll(db: PluginDatabase, pollWaMsgId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>('SELECT * FROM event_records WHERE poll_wa_msg_id = ?', pollWaMsgId);
  return row ? eventFromRow(row) : undefined;
}

export function getOpenEventByEquivalentPoll(
  db: PluginDatabase,
  pollWaMsgId: string
): StoredEventRecord | undefined {
  const rows = db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE poll_wa_msg_id IS NOT NULL
        AND event_status = 'active'
        AND group_lifecycle_status = 'poll_open'
      ORDER BY starts_at ASC, id ASC`
  );
  const row = rows.find((candidate) =>
    equivalentWhatsAppMessageIds(candidate.poll_wa_msg_id ?? undefined, pollWaMsgId)
  );
  return row ? eventFromRow(row) : undefined;
}

export function getEventByEquivalentPoll(db: PluginDatabase, pollWaMsgId: string): StoredEventRecord | undefined {
  const exact = getEventByPoll(db, pollWaMsgId);
  if (exact) {
    return exact;
  }
  const rows = db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE poll_wa_msg_id IS NOT NULL
        AND event_status = 'active'
        AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed')
      ORDER BY starts_at ASC, id ASC`
  );
  const row = rows.find((candidate) => equivalentWhatsAppMessageIds(candidate.poll_wa_msg_id ?? undefined, pollWaMsgId));
  return row ? eventFromRow(row) : undefined;
}

export function getActiveEventByPoll(db: PluginDatabase, pollWaMsgId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>(
    `SELECT * FROM event_records
      WHERE poll_wa_msg_id = ?
        AND event_status = 'active'
        AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed')
      ORDER BY starts_at ASC, id ASC
      LIMIT 1`,
    pollWaMsgId
  );
  return row ? eventFromRow(row) : undefined;
}

export function getLiveEventBySubgroup(db: PluginDatabase, subgroupChatId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>(
    `SELECT * FROM event_records
      WHERE subgroup_chat_id = ?
        AND (
          (event_status = 'active' AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed'))
          OR (event_status = 'completed' AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed'))
        )
      ORDER BY starts_at ASC, id ASC
      LIMIT 1`,
    subgroupChatId
  );
  return row ? eventFromRow(row) : undefined;
}

export function listEventsBySubgroupChatId(
  db: PluginDatabase,
  scopeId: string,
  subgroupChatId: string
): StoredEventRecord[] {
  const rows = db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE scope_id = ?
        AND subgroup_chat_id = ?
        AND (
          (event_status = 'active' AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed'))
          OR (event_status = 'completed' AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed', 'cleaned'))
        )
      ORDER BY starts_at ASC, id ASC`,
    scopeId,
    subgroupChatId
  );
  return rows.map(eventFromRow);
}

export function listCancellableEvents(
  db: PluginDatabase,
  scopeId: string,
  now: string = new Date().toISOString()
): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE scope_id = ?
        AND event_status = 'active'
        AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed')
        AND lifecycle_complete_at > ?
      ORDER BY starts_at ASC, id ASC`,
    scopeId,
    now
  ).map(eventFromRow);
}

export function listPendingCleanupEvents(db: PluginDatabase): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE (
          event_status IN ('active', 'completed')
          AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed')
        ) OR (
          event_status = 'failed'
          AND group_lifecycle_status = 'cleanup_failed'
          AND subgroup_chat_id IS NOT NULL
          AND provisioning_recovery_generation IS NULL
          AND provisioning_recovery_attempt IS NULL
          AND provisioning_recovery_next_run_at IS NULL
          AND provisioning_recovery_halted_at IS NULL
        )
      ORDER BY cleanup_at ASC, id ASC`
  ).map(eventFromRow);
}

export function listPendingCompletionEvents(db: PluginDatabase): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE event_status = 'active'
        AND lifecycle_complete_at IS NOT NULL
      ORDER BY lifecycle_complete_at ASC, id ASC`
  ).map(eventFromRow);
}

export function markEventCompletedAtEnd(db: PluginDatabase, input: {
  eventId: string;
  completedAt: string;
}): boolean {
  return db.run(
    `UPDATE event_records
        SET event_status = 'completed', updated_at = ?
      WHERE id = ? AND event_status = 'active'`,
    input.completedAt,
    input.eventId
  ).changes === 1;
}

export function listWeatherForecastCandidateEvents(db: PluginDatabase): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE event_records.event_status = 'active'
        AND event_records.group_lifecycle_status IN ('poll_closed', 'cleanup_failed')
        AND event_records.subgroup_chat_id IS NOT NULL
      ORDER BY event_records.starts_at ASC, event_records.id ASC`
  ).map(eventFromRow);
}

export function listOpenPollEvents(db: PluginDatabase): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE event_status = 'active'
        AND group_lifecycle_status = 'poll_open'
        AND poll_wa_msg_id IS NOT NULL
      ORDER BY close_at ASC, starts_at ASC, id ASC`
  ).map(eventFromRow);
}

export function listInterruptedEventPreCreateClaims(db: PluginDatabase): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE subgroup_chat_id IS NULL
        AND provisioning_recovery_generation IS NOT NULL
        AND provisioning_recovery_attempt IS NOT NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND provisioning_recovery_halted_at IS NULL
        AND (
          (origin IN ('created', 'adopted_poll')
            AND event_status = 'active'
            AND group_lifecycle_status = 'poll_open'
            AND poll_wa_msg_id IS NOT NULL)
          OR
          (event_status = 'failed'
            AND group_lifecycle_status = 'none'
            AND calendar_status IN ('hidden', 'included')
            AND (
              (origin IN ('created', 'adopted_poll') AND poll_wa_msg_id IS NOT NULL)
              OR (origin = 'unplanned' AND poll_wa_msg_id IS NULL)
            ))
        )
      ORDER BY updated_at ASC, id ASC`
  ).map(eventFromRow);
}

export function listFailedProvisioningEvents(db: PluginDatabase): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE event_status = 'failed'
        AND (
          (group_lifecycle_status IN ('none', 'poll_closed') AND subgroup_chat_id IS NOT NULL)
          OR (
            group_lifecycle_status = 'none'
            AND subgroup_chat_id IS NULL
            AND provisioning_recovery_generation IS NOT NULL
            AND provisioning_recovery_attempt IS NOT NULL
            AND provisioning_recovery_next_run_at IS NOT NULL
          )
        )
      ORDER BY updated_at ASC, id ASC`
  ).map(eventFromRow);
}

export function markClaimedEventReadyForCommunityLink(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  recoveryGeneration: string;
  recoveryAttempt: number;
  closedAt: string;
  preparedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'failed',
            group_lifecycle_status = 'poll_closed',
            calendar_status = 'included',
            subgroup_title = ?,
            closed_at = COALESCE(closed_at, ?),
            error = 'Community subgroup link is pending.',
            provisioning_recovery_next_run_at = NULL,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND subgroup_chat_id = ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND (
          (event_status = 'active' AND group_lifecycle_status = 'poll_open')
          OR (event_status = 'failed' AND group_lifecycle_status = 'none')
        )`,
    input.subgroupTitle,
    input.closedAt,
    input.preparedAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId,
    input.recoveryGeneration,
    input.recoveryAttempt
  );
  return result.changes === 1;
}

/**
 * Makes an already-configured, exact claimed child calendar-visible before its
 * physical community link is attempted. This is deliberately idempotent for
 * the same claim so crash recovery can repair the hidden poll_closed state
 * left by an interrupted older attempt without replaying subgroup settings.
 *
 * Migration 029's event_records trigger durably advances the calendar
 * publication generation in the same transaction as hidden -> included.
 */
export function includeClaimedEventCalendarBeforeCommunityLink(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  recoveryGeneration: string;
  recoveryAttempt: number;
  includedAt: string;
}): boolean {
  return db.transaction(() => {
    const included = db.run(
      `UPDATE event_records
          SET calendar_status = 'included',
              error = 'Community subgroup link is pending.',
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND event_status = 'failed'
          AND group_lifecycle_status = 'poll_closed'
          AND calendar_status = 'hidden'
          AND subgroup_chat_id = ?
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND provisioning_recovery_next_run_at IS NULL`,
      input.includedAt,
      input.eventId,
      input.scopeId,
      input.subgroupChatId,
      input.recoveryGeneration,
      input.recoveryAttempt
    );
    if (included.changes === 1) {
      return true;
    }
    return Boolean(db.get<{ id: string }>(
      `SELECT id
         FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND event_status = 'failed'
          AND group_lifecycle_status = 'poll_closed'
          AND calendar_status = 'included'
          AND subgroup_chat_id = ?
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND provisioning_recovery_next_run_at IS NULL`,
      input.eventId,
      input.scopeId,
      input.subgroupChatId,
      input.recoveryGeneration,
      input.recoveryAttempt
    ));
  });
}

export function completeClaimedEventCommunityLink(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  participants: Record<string, CreatedGroupParticipantResult>;
  creator?: EventCreatorParticipantPrincipal | undefined;
  recoveryGeneration: string;
  recoveryAttempt: number;
  completedAt: string;
}): boolean {
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id
         FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND event_status = 'failed'
          AND group_lifecycle_status = 'poll_closed'
          AND calendar_status = 'included'
          AND subgroup_chat_id = ?
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND provisioning_recovery_next_run_at IS NULL`,
      input.eventId,
      input.scopeId,
      input.subgroupChatId,
      input.recoveryGeneration,
      input.recoveryAttempt
    );
    if (!current) {
      return false;
    }
    db.run('DELETE FROM event_group_participants WHERE event_id = ?', input.eventId);
    writeCreatedGroupParticipants(db, input.eventId, input.participants, input.completedAt, input.creator);
    const result = db.run(
      `UPDATE event_records
          SET event_status = 'active',
              group_lifecycle_status = 'poll_closed',
              calendar_status = 'included',
              subgroup_title = ?,
              error = NULL,
              provisioning_recovery_generation = NULL,
              provisioning_recovery_attempt = NULL,
              provisioning_recovery_next_run_at = NULL,
              provisioning_recovery_halted_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND event_status = 'failed'
          AND group_lifecycle_status = 'poll_closed'
          AND calendar_status = 'included'
          AND subgroup_chat_id = ?
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND provisioning_recovery_next_run_at IS NULL`,
      input.subgroupTitle,
      input.completedAt,
      input.eventId,
      input.scopeId,
      input.subgroupChatId,
      input.recoveryGeneration,
      input.recoveryAttempt
    );
    if (result.changes !== 1) {
      throw new Error(`Event ${input.eventId} changed while completing its community link.`);
    }
    return true;
  });
}

export function checkpointClaimedEventParticipantOutcomes(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  participants: Record<string, CreatedGroupParticipantResult>;
  creator?: EventCreatorParticipantPrincipal | undefined;
  recoveryGeneration: string;
  recoveryAttempt: number;
  checkpointedAt: string;
  reason?: string | undefined;
}): boolean {
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id
         FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND (
            (event_status = 'active' AND group_lifecycle_status = 'poll_open')
            OR
            (event_status = 'failed' AND group_lifecycle_status IN ('none', 'poll_closed'))
          )
          AND subgroup_chat_id = ?
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND provisioning_recovery_next_run_at IS NULL`,
      input.eventId,
      input.scopeId,
      input.subgroupChatId,
      input.recoveryGeneration,
      input.recoveryAttempt
    );
    if (!current) {
      return false;
    }
    db.run('DELETE FROM event_group_participants WHERE event_id = ?', input.eventId);
    writeCreatedGroupParticipants(db, input.eventId, input.participants, input.checkpointedAt, input.creator);
    const result = db.run(
      `UPDATE event_records
          SET subgroup_title = ?,
              error = COALESCE(?, error),
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND (
            (event_status = 'active' AND group_lifecycle_status = 'poll_open')
            OR
            (event_status = 'failed' AND group_lifecycle_status IN ('none', 'poll_closed'))
          )
          AND subgroup_chat_id = ?
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND provisioning_recovery_next_run_at IS NULL`,
      input.subgroupTitle,
      input.reason ?? null,
      input.checkpointedAt,
      input.eventId,
      input.scopeId,
      input.subgroupChatId,
      input.recoveryGeneration,
      input.recoveryAttempt
    );
    if (result.changes !== 1) {
      throw new Error(`Event ${input.eventId} changed while checkpointing attendee outcomes.`);
    }
    return true;
  });
}

export function resumeHaltedKnownChildEventProvisioning(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  generation: string;
  attempt: number;
  expectedHaltedAt: string;
  resumedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status IN ('none', 'poll_closed')
        AND subgroup_chat_id = ?
        AND cleanup_at > ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_next_run_at IS NULL
        AND provisioning_recovery_halted_at = ?`,
    input.resumedAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId,
    input.resumedAt,
    input.generation,
    input.attempt,
    input.expectedHaltedAt
  );
  return result.changes === 1;
}

export function updateEventCloseAt(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  expectedUpdatedAt: string;
  closeAt: string;
  updatedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET close_at = ?, updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'active'
        AND group_lifecycle_status = 'poll_open'
        AND subgroup_chat_id IS NULL
        AND updated_at = ?
        AND provisioning_recovery_generation IS NULL
        AND provisioning_recovery_attempt IS NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM event_poll_replacements
           WHERE event_poll_replacements.event_id = event_records.id
             AND event_poll_replacements.status NOT IN ('completed', 'aborted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_announcement_delivery_claims delivery
           WHERE delivery.event_id = event_records.id
             AND delivery.status = 'sending'
        )`,
    input.closeAt,
    input.updatedAt,
    input.eventId,
    input.scopeId,
    input.expectedUpdatedAt
  );
  return result.changes === 1;
}

export function completeUnplannedEventProvisioning(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  participants: Record<string, CreatedGroupParticipantResult>;
  creator?: EventCreatorParticipantPrincipal | undefined;
  recoveryGeneration: string;
  recoveryAttempt: number;
  recoveryNextRunAt: string | null;
  completedAt: string;
}): boolean {
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id
         FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND origin = 'unplanned'
          AND event_status = 'failed'
          AND group_lifecycle_status = 'poll_closed'
          AND calendar_status = 'included'
          AND (subgroup_chat_id IS NULL OR subgroup_chat_id = ?)
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND ((? IS NULL AND provisioning_recovery_next_run_at IS NULL)
            OR provisioning_recovery_next_run_at = ?)`,
      input.eventId,
      input.scopeId,
      input.subgroupChatId,
      input.recoveryGeneration,
      input.recoveryAttempt,
      input.recoveryNextRunAt,
      input.recoveryNextRunAt
    );
    if (!current) {
      return false;
    }

    db.run('DELETE FROM event_group_participants WHERE event_id = ?', input.eventId);
    writeCreatedGroupParticipants(db, input.eventId, input.participants, input.completedAt, input.creator);
    const result = db.run(
      `UPDATE event_records
          SET event_status = 'active',
              group_lifecycle_status = 'poll_closed',
              calendar_status = 'included',
              subgroup_chat_id = ?,
              subgroup_title = ?,
              closed_at = ?,
              error = NULL,
              provisioning_recovery_generation = NULL,
              provisioning_recovery_attempt = NULL,
              provisioning_recovery_next_run_at = NULL,
              provisioning_recovery_halted_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND origin = 'unplanned'
          AND event_status = 'failed'
          AND group_lifecycle_status = 'poll_closed'
          AND calendar_status = 'included'
          AND (subgroup_chat_id IS NULL OR subgroup_chat_id = ?)
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND ((? IS NULL AND provisioning_recovery_next_run_at IS NULL)
            OR provisioning_recovery_next_run_at = ?)`,
      input.subgroupChatId,
      input.subgroupTitle,
      input.completedAt,
      input.completedAt,
      input.eventId,
      input.scopeId,
      input.subgroupChatId,
      input.recoveryGeneration,
      input.recoveryAttempt,
      input.recoveryNextRunAt,
      input.recoveryNextRunAt
    );
    if (result.changes !== 1) {
      throw new Error(`Event ${input.eventId} changed while completing unplanned subgroup provisioning.`);
    }
    db.run(
      `INSERT INTO unplanned_event_finalizations (
         event_id, scope_id, event_updated_at, generation, attempt, next_run_at, status,
         last_error, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, 1, ?, 'pending', NULL, ?, ?, NULL)`,
      input.eventId,
      input.scopeId,
      input.completedAt,
      randomUUID(),
      input.completedAt,
      input.completedAt,
      input.completedAt
    );
    appendEventLog(db, {
      eventId: input.eventId,
      action: 'events.unplanned.provisioning_completed',
      metadata: {
        subgroupChatId: input.subgroupChatId,
        subgroupTitle: input.subgroupTitle,
        participants: input.participants
      }
    });
    return true;
  });
}

export function getUnplannedEventFinalization(
  db: PluginDatabase,
  eventId: string
): StoredUnplannedEventFinalization | undefined {
  const row = db.get<UnplannedEventFinalizationRow>(
    'SELECT * FROM unplanned_event_finalizations WHERE event_id = ?',
    eventId
  );
  return row ? unplannedEventFinalizationFromRow(row) : undefined;
}

export function listPendingUnplannedEventFinalizations(
  db: PluginDatabase
): StoredUnplannedEventFinalization[] {
  return db.all<UnplannedEventFinalizationRow>(
    `SELECT *
       FROM unplanned_event_finalizations
      WHERE status = 'pending'
      ORDER BY next_run_at ASC, created_at ASC, event_id ASC`
  ).map(unplannedEventFinalizationFromRow);
}

export function completeUnplannedEventFinalization(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  generation: string;
  attempt: number;
  completedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE unplanned_event_finalizations
        SET status = 'completed',
            next_run_at = NULL,
            last_error = NULL,
            completed_at = ?,
            updated_at = ?
      WHERE event_id = ?
        AND scope_id = ?
        AND generation = ?
        AND attempt = ?
        AND status = 'pending'`,
    input.completedAt,
    input.completedAt,
    input.eventId,
    input.scopeId,
    input.generation,
    input.attempt
  );
  return result.changes === 1;
}

export function advanceUnplannedEventFinalization(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  generation: string;
  expectedAttempt: number;
  nextAttempt: number;
  nextRunAt: string;
  reason: string;
  updatedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE unplanned_event_finalizations
        SET attempt = ?,
            next_run_at = ?,
            last_error = ?,
            updated_at = ?
      WHERE event_id = ?
        AND scope_id = ?
        AND generation = ?
        AND attempt = ?
        AND status = 'pending'`,
    input.nextAttempt,
    input.nextRunAt,
    input.reason,
    input.updatedAt,
    input.eventId,
    input.scopeId,
    input.generation,
    input.expectedAttempt
  );
  return result.changes === 1;
}

export function markEventClosed(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  expectedUpdatedAt: string;
  expectedSubgroupChatId?: string | undefined;
  expectedRecoveryGeneration?: string | undefined;
  expectedRecoveryAttempt?: number | undefined;
  subgroupChatId?: string | undefined;
  subgroupTitle?: string | undefined;
  closedAt: string;
}): boolean {
  if (
    (input.expectedSubgroupChatId ?? null) !== (input.subgroupChatId ?? null)
  ) {
    return false;
  }
  const hasRecoveryClaim = input.expectedRecoveryGeneration !== undefined ||
    input.expectedRecoveryAttempt !== undefined;
  if (
    hasRecoveryClaim &&
    (!input.expectedRecoveryGeneration || input.expectedRecoveryAttempt === undefined)
  ) {
    return false;
  }
  const result = db.run(
    `UPDATE event_records
        SET group_lifecycle_status = 'poll_closed',
            subgroup_chat_id = ?,
            subgroup_title = ?,
            closed_at = ?,
            error = NULL,
            provisioning_recovery_generation = NULL,
            provisioning_recovery_attempt = NULL,
            provisioning_recovery_next_run_at = NULL,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'active'
        AND group_lifecycle_status = 'poll_open'
        AND updated_at = ?
        AND ((? IS NULL AND subgroup_chat_id IS NULL) OR subgroup_chat_id = ?)
        AND (
          (? IS NULL
            AND provisioning_recovery_generation IS NULL
            AND provisioning_recovery_attempt IS NULL
            AND provisioning_recovery_next_run_at IS NULL)
          OR
          (? IS NOT NULL
            AND provisioning_recovery_generation = ?
            AND provisioning_recovery_attempt = ?
            AND provisioning_recovery_next_run_at IS NULL)
        )`,
    input.subgroupChatId ?? null,
    input.subgroupTitle ?? null,
    input.closedAt,
    input.closedAt,
    input.eventId,
    input.scopeId,
    input.expectedUpdatedAt,
    input.expectedSubgroupChatId ?? null,
    input.expectedSubgroupChatId ?? null,
    input.expectedRecoveryGeneration ?? null,
    input.expectedRecoveryGeneration ?? null,
    input.expectedRecoveryGeneration ?? null,
    input.expectedRecoveryAttempt ?? null
  );
  return result.changes === 1;
}

export function markEventCleaned(db: PluginDatabase, input: {
  eventId: string;
  expectedUpdatedAt: string;
  cleanedAt: string;
}): boolean {
  return db.transaction(() => {
    const result = db.run(
      `UPDATE event_records
          SET event_status = 'completed',
              group_lifecycle_status = 'cleaned',
              cleaned_at = ?,
              error = NULL,
              provisioning_recovery_generation = NULL,
              provisioning_recovery_attempt = NULL,
              provisioning_recovery_next_run_at = NULL,
              provisioning_recovery_halted_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND (
            (event_status IN ('active', 'completed')
              AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed'))
            OR
            (event_status = 'failed'
              AND group_lifecycle_status = 'cleanup_failed'
              AND subgroup_chat_id IS NOT NULL
              AND provisioning_recovery_generation IS NULL
              AND provisioning_recovery_attempt IS NULL
              AND provisioning_recovery_next_run_at IS NULL
              AND provisioning_recovery_halted_at IS NULL)
          )
          AND updated_at = ?
          AND NOT EXISTS (
            SELECT 1 FROM event_cleanup_claims
             WHERE event_cleanup_claims.event_id = event_records.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_announcement_delivery_claims delivery
             WHERE delivery.event_id = event_records.id
               AND delivery.status = 'sending'
               AND delivery.lease_expires_at > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_edit_repairs repair
             WHERE repair.event_id = event_records.id
               AND repair.status = 'pending'
               AND repair.execution_claim_id IS NOT NULL
               AND repair.execution_lease_expires_at > ?
          )`,
      input.cleanedAt,
      input.cleanedAt,
      input.eventId,
      input.expectedUpdatedAt,
      input.cleanedAt,
      input.cleanedAt
    );
    if (result.changes !== 1) {
      return false;
    }
    supersedeEventEditPresentationForTerminalTransition(db, input.eventId, input.cleanedAt);
    return true;
  });
}

export function claimEventCleanup(db: PluginDatabase, input: {
  eventId: string;
  expectedUpdatedAt: string;
  expectedCleanupAt: string;
  claimedAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
  allowBeforeDeadline?: boolean | undefined;
}): EventCleanupClaim | undefined {
  const claimId = `evtcleanup-${randomUUID()}`;
  const claimedAt = input.claimedAt ?? new Date().toISOString();
  const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
    new Date(claimedAt).getTime() + EVENT_CLEANUP_CLAIM_LEASE_MS
  ).toISOString();
  const result = db.run(
    `INSERT INTO event_cleanup_claims (
       event_id, claim_id, expected_event_updated_at, claimed_cleanup_at, claimed_at, lease_expires_at
     )
     SELECT id, ?, updated_at, cleanup_at, ?, ?
       FROM event_records
      WHERE id = ?
        AND (
          (event_status IN ('active', 'completed')
            AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed'))
          OR
          (event_status = 'failed'
            AND group_lifecycle_status = 'cleanup_failed'
            AND subgroup_chat_id IS NOT NULL
            AND provisioning_recovery_generation IS NULL
            AND provisioning_recovery_attempt IS NULL
            AND provisioning_recovery_next_run_at IS NULL
            AND provisioning_recovery_halted_at IS NULL)
        )
        AND updated_at = ?
        AND cleanup_at = ?
        AND (? = 1 OR cleanup_at <= ?)
        AND NOT EXISTS (
          SELECT 1
            FROM event_cleanup_claims
           WHERE event_cleanup_claims.event_id = event_records.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_announcement_delivery_claims delivery
           WHERE delivery.event_id = event_records.id
             AND delivery.status = 'sending'
             AND delivery.lease_expires_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_edit_repairs repair
           WHERE repair.event_id = event_records.id
             AND repair.status = 'pending'
             AND repair.execution_claim_id IS NOT NULL
             AND repair.execution_lease_expires_at > ?
        )`,
    claimId,
    claimedAt,
    leaseExpiresAt,
    input.eventId,
    input.expectedUpdatedAt,
    input.expectedCleanupAt,
    input.allowBeforeDeadline ? 1 : 0,
    claimedAt,
    claimedAt,
    claimedAt
  );
  return result.changes === 1
    ? {
        eventId: input.eventId,
        claimId,
        expectedEventUpdatedAt: input.expectedUpdatedAt,
        claimedCleanupAt: input.expectedCleanupAt,
        claimedAt,
        leaseExpiresAt
      }
      : undefined;
}

/** Acquires the cleanup mutation fence for cancellation before its deadline. */
export function claimEventCancellationCleanup(db: PluginDatabase, input: {
  eventId: string;
  expectedUpdatedAt: string;
  claimedAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
}): EventCleanupClaim | undefined {
  const claimId = `evtcancel-${randomUUID()}`;
  const claimedAt = input.claimedAt ?? new Date().toISOString();
  const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
    new Date(claimedAt).getTime() + EVENT_CLEANUP_CLAIM_LEASE_MS
  ).toISOString();
  return db.transaction(() => {
    releaseExpiredEventCleanupClaims(db, claimedAt);
    const result = db.run(
      `INSERT INTO event_cleanup_claims (
         event_id, claim_id, expected_event_updated_at, claimed_cleanup_at, claimed_at, lease_expires_at
       )
       SELECT id, ?, updated_at, cleanup_at, ?, ?
         FROM event_records
        WHERE id = ?
          AND event_status = 'active'
          AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed')
          AND updated_at = ?
          AND provisioning_recovery_generation IS NULL
          AND provisioning_recovery_attempt IS NULL
          AND provisioning_recovery_next_run_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM event_cleanup_claims cleanup
             WHERE cleanup.event_id = event_records.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_poll_replacements replacement
             WHERE replacement.event_id = event_records.id
               AND replacement.status NOT IN ('completed', 'aborted')
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_announcement_delivery_claims delivery
             WHERE delivery.event_id = event_records.id
               AND delivery.status = 'sending'
               AND delivery.lease_expires_at > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_edit_repairs repair
             WHERE repair.event_id = event_records.id
               AND repair.status = 'pending'
               AND repair.execution_claim_id IS NOT NULL
               AND repair.execution_lease_expires_at > ?
          )`,
      claimId,
      claimedAt,
      leaseExpiresAt,
      input.eventId,
      input.expectedUpdatedAt,
      claimedAt,
      claimedAt
    );
    if (result.changes !== 1) {
      return undefined;
    }
    const event = getEvent(db, input.eventId);
    if (!event) {
      throw new Error(`Event ${input.eventId} disappeared while its cancellation claim was created.`);
    }
    return {
      eventId: input.eventId,
      claimId,
      expectedEventUpdatedAt: input.expectedUpdatedAt,
      claimedCleanupAt: event.cleanupAt,
      claimedAt,
      leaseExpiresAt
    };
  });
}

export function getEventCleanupClaim(db: PluginDatabase, eventId: string): EventCleanupClaim | undefined {
  const row = db.get<EventCleanupClaimRow>(
    'SELECT * FROM event_cleanup_claims WHERE event_id = ?',
    eventId
  );
  return row ? eventCleanupClaimFromRow(row) : undefined;
}

export function getEventAnnouncementSendingLeaseExpiresAt(
  db: PluginDatabase,
  eventId: string
): string | undefined {
  const row = db.get<{ lease_expires_at: string | null }>(
    `SELECT MAX(lease_expires_at) AS lease_expires_at
       FROM event_announcement_delivery_claims
      WHERE event_id = ? AND status = 'sending'`,
    eventId
  );
  return row?.lease_expires_at ?? undefined;
}

export function renewEventCleanupClaim(db: PluginDatabase, input: {
  eventId: string;
  claimId: string;
  expectedUpdatedAt: string;
  leaseExpiresAt: string;
}): boolean {
  return db.run(
    `UPDATE event_cleanup_claims
        SET lease_expires_at = ?
      WHERE event_id = ?
        AND claim_id = ?
        AND expected_event_updated_at = ?
        AND EXISTS (
          SELECT 1 FROM event_records
           WHERE event_records.id = event_cleanup_claims.event_id
             AND event_records.updated_at = event_cleanup_claims.expected_event_updated_at
        )`,
    input.leaseExpiresAt,
    input.eventId,
    input.claimId,
    input.expectedUpdatedAt
  ).changes === 1;
}

export function releaseExpiredEventCleanupClaims(
  db: PluginDatabase,
  now: string = new Date().toISOString()
): number {
  return db.run(
    `DELETE FROM event_cleanup_claims
      WHERE lease_expires_at IS NULL OR lease_expires_at <= ?`,
    now
  ).changes;
}

export function releaseEventCleanupClaim(db: PluginDatabase, input: {
  eventId: string;
  claimId: string;
}): boolean {
  return db.run(
    `DELETE FROM event_cleanup_claims
      WHERE event_id = ? AND claim_id = ?`,
    input.eventId,
    input.claimId
  ).changes === 1;
}

/**
 * Exclusively fences one rejected, halted community-link candidate before the
 * operator dismantles it. The structured operator-required log is the failure
 * classification; provider error text is deliberately not inspected.
 */
export function getRejectedEventChildReplacementOperationStatus(
  db: PluginDatabase,
  input: RejectedEventChildReplacementExpectation,
  observedAt: string = new Date().toISOString()
): RejectedEventChildReplacementOperationStatus | undefined {
  const event = getEvent(db, input.eventId);
  if (!event || event.scopeId !== input.scopeId) {
    return undefined;
  }
  const child = input.rejectedSubgroupChatId.trim().toLowerCase();
  const scheduled = db.get<{ replacement_generation: string }>(
    `SELECT json_extract(metadata_json, '$.replacementGeneration') AS replacement_generation
       FROM event_logs
      WHERE event_id = ?
        AND action = 'events.provisioning.legacy_child_replacement_scheduled'
        AND json_extract(metadata_json, '$.operationId') = ?
        AND lower(json_extract(metadata_json, '$.rejectedSubgroupChatId')) = ?
      ORDER BY rowid DESC
      LIMIT 1`,
    input.eventId,
    input.operationId,
    child
  );
  if (scheduled?.replacement_generation?.trim()) {
    return {
      status: 'already_scheduled',
      event,
      replacementGeneration: scheduled.replacement_generation
    };
  }
  const expired = db.get<{ id: string }>(
    `SELECT id
       FROM event_logs
      WHERE event_id = ?
        AND action = 'events.provisioning.legacy_child_replacement_expired'
        AND json_extract(metadata_json, '$.operationId') = ?
        AND lower(json_extract(metadata_json, '$.rejectedSubgroupChatId')) = ?
      ORDER BY rowid DESC
      LIMIT 1`,
    input.eventId,
    input.operationId,
    child
  );
  if (expired) {
    return { status: 'already_expired', event };
  }
  const aborted = db.get<{ reason: string | null }>(
    `SELECT json_extract(metadata_json, '$.reason') AS reason
       FROM event_logs
      WHERE event_id = ?
        AND action = 'events.provisioning.legacy_child_replacement_aborted'
        AND json_extract(metadata_json, '$.operationId') = ?
        AND lower(json_extract(metadata_json, '$.rejectedSubgroupChatId')) = ?
      ORDER BY rowid DESC
      LIMIT 1`,
    input.eventId,
    input.operationId,
    child
  );
  if (aborted) {
    return {
      status: 'aborted',
      event,
      reason: aborted.reason ?? 'Rejected-child replacement was aborted before dismantle.'
    };
  }
  const claim = getEventCleanupClaim(db, input.eventId);
  if (
    claim &&
    claim.expectedEventUpdatedAt === event.updatedAt &&
    new Date(claim.leaseExpiresAt).getTime() > new Date(observedAt).getTime() &&
    event.eventStatus === 'failed' &&
    event.groupLifecycleStatus === 'cleanup_failed' &&
    event.calendarStatus === 'included' &&
    event.subgroupChatId?.toLowerCase() === child
  ) {
    const claimLog = db.get<{ id: string }>(
      `SELECT id
         FROM event_logs
        WHERE event_id = ?
          AND action IN (
            'events.provisioning.legacy_child_replacement_claimed',
            'events.provisioning.legacy_child_replacement_reclaimed'
          )
          AND json_extract(metadata_json, '$.operationId') = ?
          AND lower(json_extract(metadata_json, '$.rejectedSubgroupChatId')) = ?
          AND json_extract(metadata_json, '$.expectedUpdatedAt') = ?
          AND json_extract(metadata_json, '$.expectedProvisioningGeneration') = ?
          AND json_extract(metadata_json, '$.expectedProvisioningAttempt') = ?
          AND json_extract(metadata_json, '$.expectedProvisioningHaltedAt') = ?
        ORDER BY rowid DESC
        LIMIT 1`,
      input.eventId,
      input.operationId,
      child,
      input.expectedUpdatedAt,
      input.expectedProvisioningGeneration,
      input.expectedProvisioningAttempt,
      input.expectedProvisioningHaltedAt
    );
    if (claimLog) {
      return { status: 'in_progress', event, claim };
    }
  }
  const authorized = db.get<{ id: string }>(
    `SELECT id
       FROM event_logs
      WHERE event_id = ?
        AND action = 'events.provisioning.legacy_child_replacement_dismantle_authorized'
        AND json_extract(metadata_json, '$.operationId') = ?
        AND lower(json_extract(metadata_json, '$.rejectedSubgroupChatId')) = ?
        AND json_extract(metadata_json, '$.expectedUpdatedAt') = ?
        AND json_extract(metadata_json, '$.expectedProvisioningGeneration') = ?
        AND json_extract(metadata_json, '$.expectedProvisioningAttempt') = ?
        AND json_extract(metadata_json, '$.expectedProvisioningHaltedAt') = ?
      ORDER BY rowid DESC
      LIMIT 1`,
    input.eventId,
    input.operationId,
    child,
    input.expectedUpdatedAt,
    input.expectedProvisioningGeneration,
    input.expectedProvisioningAttempt,
    input.expectedProvisioningHaltedAt
  );
  if (authorized) {
    return { status: 'dismantle_authorized', event };
  }
  return undefined;
}

export function claimRejectedEventChildReplacement(
  db: PluginDatabase,
  input: RejectedEventChildReplacementExpectation & {
    claimedAt: string;
    leaseExpiresAt?: string | undefined;
  }
): RejectedEventChildReplacementClaimResult {
  const eventId = requiredTrimmedValue(input.eventId, 'replacement event ID');
  const scopeId = requiredTrimmedValue(input.scopeId, 'replacement scope ID');
  const rejectedSubgroupChatId = requiredTrimmedValue(
    input.rejectedSubgroupChatId,
    'rejected subgroup chat ID'
  ).toLowerCase();
  const operationId = requiredTrimmedValue(input.operationId, 'replacement operation ID');
  const reason = requiredTrimmedValue(input.reason, 'replacement reason');
  const actorWid = requiredTrimmedValue(input.actorWid, 'replacement actor WID');
  const actorLabel = requiredTrimmedValue(input.actorLabel, 'replacement actor label');
  const claimedTime = new Date(input.claimedAt).getTime();
  if (!Number.isFinite(claimedTime)) {
    return { status: 'rejected', reason: `Invalid replacement claim time ${input.claimedAt}.` };
  }
  if (!Number.isInteger(input.expectedProvisioningAttempt) || input.expectedProvisioningAttempt < 1) {
    return { status: 'rejected', reason: 'Replacement provisioning attempt must be a positive integer.' };
  }

  return db.transaction(() => {
    releaseExpiredEventCleanupClaims(db, input.claimedAt);
    let event = getEvent(db, eventId);
    if (!event || event.scopeId !== scopeId) {
      return {
        status: 'not_found',
        reason: `Unknown event ${eventId} in scope ${scopeId}.`
      };
    }

    const scheduledLog = db.get<{ id: string; replacement_generation: string }>(
      `SELECT id,
              json_extract(metadata_json, '$.replacementGeneration') AS replacement_generation
         FROM event_logs
        WHERE event_id = ?
          AND action = 'events.provisioning.legacy_child_replacement_scheduled'
          AND json_extract(metadata_json, '$.operationId') = ?
          AND lower(json_extract(metadata_json, '$.rejectedSubgroupChatId')) = ?
        ORDER BY rowid DESC
        LIMIT 1`,
      eventId,
      operationId,
      rejectedSubgroupChatId
    );
    if (scheduledLog?.replacement_generation?.trim()) {
      return {
        status: 'already_scheduled',
        event,
        replacementGeneration: scheduledLog.replacement_generation
      };
    }
    const expiredLog = db.get<{ id: string }>(
      `SELECT id
         FROM event_logs
        WHERE event_id = ?
          AND action = 'events.provisioning.legacy_child_replacement_expired'
          AND json_extract(metadata_json, '$.operationId') = ?
          AND lower(json_extract(metadata_json, '$.rejectedSubgroupChatId')) = ?
        ORDER BY rowid DESC
        LIMIT 1`,
      eventId,
      operationId,
      rejectedSubgroupChatId
    );
    if (
      expiredLog &&
      event.eventStatus === 'completed' &&
      event.groupLifecycleStatus === 'cleaned'
    ) {
      return { status: 'already_expired', event };
    }

    const priorClaimLog = db.get<{ id: string }>(
      `SELECT id
         FROM event_logs
        WHERE event_id = ?
          AND action IN (
            'events.provisioning.legacy_child_replacement_claimed',
            'events.provisioning.legacy_child_replacement_reclaimed'
          )
          AND json_extract(metadata_json, '$.operationId') = ?
          AND lower(json_extract(metadata_json, '$.rejectedSubgroupChatId')) = ?
          AND json_extract(metadata_json, '$.expectedUpdatedAt') = ?
          AND json_extract(metadata_json, '$.expectedProvisioningGeneration') = ?
          AND json_extract(metadata_json, '$.expectedProvisioningAttempt') = ?
          AND json_extract(metadata_json, '$.expectedProvisioningHaltedAt') = ?
          AND json_extract(metadata_json, '$.failureKind') = 'community_link_rejected'
        ORDER BY rowid DESC
        LIMIT 1`,
      eventId,
      operationId,
      rejectedSubgroupChatId,
      input.expectedUpdatedAt,
      input.expectedProvisioningGeneration,
      input.expectedProvisioningAttempt,
      input.expectedProvisioningHaltedAt
    );
    const replayed = Boolean(priorClaimLog);
    const existingClaim = getEventCleanupClaim(db, eventId);
    if (existingClaim) {
      if (
        replayed &&
        event.eventStatus === 'failed' &&
        event.groupLifecycleStatus === 'cleanup_failed' &&
        event.calendarStatus === 'included' &&
        event.subgroupChatId?.toLowerCase() === rejectedSubgroupChatId &&
        existingClaim.expectedEventUpdatedAt === event.updatedAt
      ) {
        return { status: 'in_progress', event, claim: existingClaim };
      }
      return {
        status: 'rejected',
        reason: `Event ${eventId} already has an unrelated cleanup/replacement claim.`,
        event
      };
    }

    let failureEvidence = 'structured_link_parent';
    if (!replayed) {
      const exactOperatorFailure = db.get<{
        id: string;
        stage: string | null;
        source: string | null;
      }>(
        `SELECT id,
                json_extract(metadata_json, '$.stage') AS stage,
                json_extract(metadata_json, '$.source') AS source
           FROM event_logs
          WHERE event_id = ?
            AND action = 'events.provisioning.operator_required'
            AND lower(json_extract(metadata_json, '$.subgroupChatId')) = ?
            AND json_extract(metadata_json, '$.generation') = ?
            AND json_extract(metadata_json, '$.attempt') = ?
            AND json_extract(metadata_json, '$.recoveryDisposition') = 'operator_required'
            AND (
              json_extract(metadata_json, '$.stage') = 'link_parent'
              OR (
                json_extract(metadata_json, '$.stage') IS NULL
                AND json_extract(metadata_json, '$.source') = 'operator_resume'
              )
            )
          ORDER BY rowid DESC
          LIMIT 1`,
        eventId,
        rejectedSubgroupChatId,
        input.expectedProvisioningGeneration,
        input.expectedProvisioningAttempt
      );
      if (!exactOperatorFailure) {
        return {
          status: 'rejected',
          reason: `Event ${eventId} has no structured rejected community-link checkpoint for the expected child and epoch.`,
          event
        };
      }
      if (
        exactOperatorFailure.stage === null &&
        exactOperatorFailure.source === 'operator_resume'
      ) {
        failureEvidence = 'legacy_operator_resume_stage_unavailable';
      }
      if (
        event.eventStatus !== 'failed' ||
        event.groupLifecycleStatus !== 'poll_closed' ||
        event.calendarStatus !== 'included' ||
        event.subgroupChatId?.toLowerCase() !== rejectedSubgroupChatId ||
        event.updatedAt !== input.expectedUpdatedAt ||
        event.provisioningRecoveryGeneration !== input.expectedProvisioningGeneration ||
        event.provisioningRecoveryAttempt !== input.expectedProvisioningAttempt ||
        event.provisioningRecoveryNextRunAt !== undefined ||
        event.provisioningRecoveryHaltedAt !== input.expectedProvisioningHaltedAt
      ) {
        return {
          status: 'rejected',
          reason: `Event ${eventId} no longer matches the exact halted rejected-child checkpoint.`,
          event
        };
      }
    } else if (
      event.eventStatus !== 'failed' ||
      event.groupLifecycleStatus !== 'cleanup_failed' ||
      event.calendarStatus !== 'included' ||
      event.subgroupChatId?.toLowerCase() !== rejectedSubgroupChatId ||
      event.provisioningRecoveryGeneration !== undefined ||
      event.provisioningRecoveryAttempt !== undefined ||
      event.provisioningRecoveryNextRunAt !== undefined ||
      event.provisioningRecoveryHaltedAt !== undefined
    ) {
      return {
        status: 'rejected',
        reason: `Event ${eventId} is not at the durable rejected-child replacement fence.`,
        event
      };
    }

    const cleanupTime = new Date(event.cleanupAt).getTime();
    if (!Number.isFinite(cleanupTime) || claimedTime >= cleanupTime) {
      return {
        status: 'rejected',
        reason: `Event ${eventId} has reached or has an invalid cleanup deadline.`,
        event
      };
    }
    const actorIdentityId = event.actorIdentityId?.trim();
    if (!actorIdentityId) {
      return {
        status: 'rejected',
        reason: `Event ${eventId} has no authoritative creator identity.`,
        event
      };
    }
    const creator = getEventRequiredCreatorReference(db, eventId, actorIdentityId);
    if (!creator) {
      return {
        status: 'rejected',
        reason: `Event ${eventId} has no authoritative required-creator checkpoint.`,
        event
      };
    }

    const fencedAt = nextEventRevisionTimestamp(event.updatedAt, new Date(input.claimedAt));
    const fenced = db.run(
      `UPDATE event_records
          SET event_status = 'failed',
              group_lifecycle_status = 'cleanup_failed',
              error = ?,
              provisioning_recovery_generation = NULL,
              provisioning_recovery_attempt = NULL,
              provisioning_recovery_next_run_at = NULL,
              provisioning_recovery_halted_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND updated_at = ?
          AND subgroup_chat_id = ?
          AND cleanup_at > ?`,
      `Rejected legacy subgroup replacement ${operationId} is dismantling ${rejectedSubgroupChatId}.`,
      fencedAt,
      eventId,
      scopeId,
      event.updatedAt,
      event.subgroupChatId!,
      fencedAt
    ).changes === 1;
    if (!fenced) {
      return {
        status: 'rejected',
        reason: `Event ${eventId} changed while its rejected child was being fenced.`,
        event: getEvent(db, eventId) ?? event
      };
    }

    const claimId = `evtreplace-${randomUUID()}`;
    const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
      new Date(fencedAt).getTime() + EVENT_CLEANUP_CLAIM_LEASE_MS
    ).toISOString();
    const inserted = db.run(
      `INSERT INTO event_cleanup_claims (
         event_id, claim_id, expected_event_updated_at, claimed_cleanup_at, claimed_at, lease_expires_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      eventId,
      claimId,
      fencedAt,
      event.cleanupAt,
      fencedAt,
      leaseExpiresAt
    ).changes === 1;
    if (!inserted) {
      throw new Error(`Unable to persist rejected-child replacement claim ${claimId}.`);
    }
    appendEventLog(db, {
      eventId,
      action: replayed
        ? 'events.provisioning.legacy_child_replacement_reclaimed'
        : 'events.provisioning.legacy_child_replacement_claimed',
      metadata: {
        operationId,
        failureKind: input.failureKind,
        reason,
        actorWid,
        actorLabel,
        rejectedSubgroupChatId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        expectedProvisioningGeneration: input.expectedProvisioningGeneration,
        expectedProvisioningAttempt: input.expectedProvisioningAttempt,
        expectedProvisioningHaltedAt: input.expectedProvisioningHaltedAt,
        creatorIdentityId: creator.identityId,
        creatorParticipantWid: creator.participantWid,
        ...(creator.evidenceDigest ? { creatorEvidenceDigest: creator.evidenceDigest } : {}),
        claimId,
        fencedAt,
        failureEvidence
      }
    });
    event = getEvent(db, eventId) ?? event;
    return {
      status: 'claimed',
      event,
      claim: {
        eventId,
        claimId,
        expectedEventUpdatedAt: fencedAt,
        claimedCleanupAt: event.cleanupAt,
        claimedAt: fencedAt,
        leaseExpiresAt
      },
      creator,
      replayed
    };
  });
}

export type CompleteRejectedEventChildReplacementResult =
  | { status: 'scheduled'; event: StoredEventRecord }
  | { status: 'expired_cleaned'; event: StoredEventRecord }
  | { status: 'stale'; event?: StoredEventRecord | undefined };

export function authorizeClaimedRejectedEventChildDismantle(
  db: PluginDatabase,
  input: RejectedEventChildReplacementExpectation & {
    claim: EventCleanupClaim;
    authorizedAt: string;
    probe: unknown;
  }
): boolean {
  return db.transaction(() => {
    const event = getEvent(db, input.eventId);
    const claim = getEventCleanupClaim(db, input.eventId);
    if (
      !event ||
      event.scopeId !== input.scopeId ||
      event.eventStatus !== 'failed' ||
      event.groupLifecycleStatus !== 'cleanup_failed' ||
      event.calendarStatus !== 'included' ||
      event.subgroupChatId?.toLowerCase() !== input.rejectedSubgroupChatId.toLowerCase() ||
      event.updatedAt !== input.claim.expectedEventUpdatedAt ||
      !claim ||
      claim.claimId !== input.claim.claimId ||
      claim.expectedEventUpdatedAt !== event.updatedAt
    ) {
      return false;
    }
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.legacy_child_replacement_dismantle_authorized',
      metadata: {
        operationId: input.operationId,
        failureKind: input.failureKind,
        rejectedSubgroupChatId: input.rejectedSubgroupChatId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        expectedProvisioningGeneration: input.expectedProvisioningGeneration,
        expectedProvisioningAttempt: input.expectedProvisioningAttempt,
        expectedProvisioningHaltedAt: input.expectedProvisioningHaltedAt,
        claimId: input.claim.claimId,
        authorizedAt: input.authorizedAt,
        probe: input.probe
      }
    });
    return true;
  });
}

/** Restores the exact halted cursor when the final pre-provider probe fails. */
export function abortClaimedRejectedEventChildReplacementBeforeDismantle(
  db: PluginDatabase,
  input: RejectedEventChildReplacementExpectation & {
    claim: EventCleanupClaim;
    abortReason: string;
    abortedAt: string;
  }
): boolean {
  return db.transaction(() => {
    const event = getEvent(db, input.eventId);
    const claim = getEventCleanupClaim(db, input.eventId);
    if (
      !event ||
      event.scopeId !== input.scopeId ||
      event.eventStatus !== 'failed' ||
      event.groupLifecycleStatus !== 'cleanup_failed' ||
      event.calendarStatus !== 'included' ||
      event.subgroupChatId?.toLowerCase() !== input.rejectedSubgroupChatId.toLowerCase() ||
      event.updatedAt !== input.claim.expectedEventUpdatedAt ||
      !claim ||
      claim.claimId !== input.claim.claimId ||
      claim.expectedEventUpdatedAt !== event.updatedAt
    ) {
      return false;
    }
    const abortedAt = nextEventRevisionTimestamp(event.updatedAt, new Date(input.abortedAt));
    const restored = db.run(
      `UPDATE event_records
          SET event_status = 'failed',
              group_lifecycle_status = 'poll_closed',
              error = ?,
              provisioning_recovery_generation = ?,
              provisioning_recovery_attempt = ?,
              provisioning_recovery_next_run_at = NULL,
              provisioning_recovery_halted_at = ?,
              updated_at = ?
        WHERE id = ? AND updated_at = ?`,
      input.abortReason,
      input.expectedProvisioningGeneration,
      input.expectedProvisioningAttempt,
      input.expectedProvisioningHaltedAt,
      abortedAt,
      event.id,
      event.updatedAt
    ).changes === 1;
    if (!restored || !releaseEventCleanupClaim(db, {
      eventId: event.id,
      claimId: input.claim.claimId
    })) {
      throw new Error(`Unable to abort replacement claim ${input.claim.claimId}.`);
    }
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.legacy_child_replacement_aborted',
      metadata: {
        operationId: input.operationId,
        failureKind: input.failureKind,
        rejectedSubgroupChatId: input.rejectedSubgroupChatId,
        expectedProvisioningGeneration: input.expectedProvisioningGeneration,
        expectedProvisioningAttempt: input.expectedProvisioningAttempt,
        expectedProvisioningHaltedAt: input.expectedProvisioningHaltedAt,
        reason: input.abortReason,
        abortedAt
      }
    });
    return true;
  });
}

export function completeClaimedRejectedEventChildReplacement(
  db: PluginDatabase,
  input: RejectedEventChildReplacementExpectation & {
    claim: EventCleanupClaim;
    replacementGeneration: string;
    completedAt: string;
  }
): CompleteRejectedEventChildReplacementResult {
  const completedTime = new Date(input.completedAt).getTime();
  if (!Number.isFinite(completedTime)) {
    throw new Error(`Invalid rejected-child replacement completion time ${input.completedAt}.`);
  }
  return db.transaction(() => {
    const event = getEvent(db, input.eventId);
    const exactClaim = getEventCleanupClaim(db, input.eventId);
    if (
      !event ||
      event.scopeId !== input.scopeId ||
      event.eventStatus !== 'failed' ||
      event.groupLifecycleStatus !== 'cleanup_failed' ||
      event.calendarStatus !== 'included' ||
      event.subgroupChatId?.toLowerCase() !== input.rejectedSubgroupChatId.toLowerCase() ||
      event.updatedAt !== input.claim.expectedEventUpdatedAt ||
      event.provisioningRecoveryGeneration !== undefined ||
      event.provisioningRecoveryAttempt !== undefined ||
      event.provisioningRecoveryNextRunAt !== undefined ||
      event.provisioningRecoveryHaltedAt !== undefined ||
      !exactClaim ||
      exactClaim.claimId !== input.claim.claimId ||
      exactClaim.expectedEventUpdatedAt !== event.updatedAt
    ) {
      return { status: 'stale', ...(event ? { event } : {}) };
    }
    const cleanupTime = new Date(event.cleanupAt).getTime();
    const completedAt = nextEventRevisionTimestamp(event.updatedAt, new Date(input.completedAt));
    if (!Number.isFinite(cleanupTime) || completedTime >= cleanupTime) {
      const cleaned = db.run(
        `UPDATE event_records
            SET event_status = 'completed',
                group_lifecycle_status = 'cleaned',
                cleaned_at = ?,
                error = NULL,
                updated_at = ?
          WHERE id = ? AND updated_at = ?`,
        completedAt,
        completedAt,
        event.id,
        event.updatedAt
      ).changes === 1;
      if (!cleaned || !releaseEventCleanupClaim(db, {
        eventId: event.id,
        claimId: input.claim.claimId
      })) {
        throw new Error(`Unable to terminalize expired replacement ${input.operationId}.`);
      }
      appendEventLog(db, {
        eventId: event.id,
        action: 'events.provisioning.legacy_child_replacement_expired',
        metadata: {
          operationId: input.operationId,
          rejectedSubgroupChatId: input.rejectedSubgroupChatId,
          cleanedAt: completedAt
        }
      });
      return { status: 'expired_cleaned', event: getEvent(db, event.id)! };
    }

    const generation = requiredTrimmedValue(
      input.replacementGeneration,
      'replacement provisioning generation'
    );
    db.run(
      `DELETE FROM event_group_participants
        WHERE event_id = ?
          AND NOT (
            identity_id = ?
            AND required_creator_membership_status IS NOT NULL
          )`,
      event.id,
      event.actorIdentityId!
    );
    db.run(
      `UPDATE event_group_participants
          SET status_code = NULL,
              message = NULL,
              is_group_creator = 0,
              is_invite_v4_sent = 0,
              required_creator_membership_status = 'initial_create_missing',
              created_at = ?
        WHERE event_id = ?
          AND identity_id = ?
          AND required_creator_membership_status IS NOT NULL`,
      completedAt,
      event.id,
      event.actorIdentityId!
    );
    db.run('DELETE FROM unplanned_event_finalizations WHERE event_id = ?', event.id);
    const scheduled = db.run(
      `UPDATE event_records
          SET event_status = 'failed',
              group_lifecycle_status = 'none',
              subgroup_chat_id = NULL,
              subgroup_title = NULL,
              error = ?,
              provisioning_recovery_generation = ?,
              provisioning_recovery_attempt = 1,
              provisioning_recovery_next_run_at = ?,
              provisioning_recovery_halted_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND updated_at = ?
          AND subgroup_chat_id = ?`,
      `Rejected legacy subgroup ${input.rejectedSubgroupChatId} was retired; replacement provisioning is scheduled.`,
      generation,
      completedAt,
      completedAt,
      event.id,
      event.updatedAt,
      event.subgroupChatId!
    ).changes === 1;
    if (!scheduled || !releaseEventCleanupClaim(db, {
      eventId: event.id,
      claimId: input.claim.claimId
    })) {
      throw new Error(`Unable to schedule replacement provisioning for event ${event.id}.`);
    }
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.legacy_child_retired',
      metadata: {
        operationId: input.operationId,
        rejectedSubgroupChatId: input.rejectedSubgroupChatId,
        retiredAt: completedAt
      }
    });
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.legacy_child_replacement_scheduled',
      metadata: {
        operationId: input.operationId,
        failureKind: input.failureKind,
        rejectedSubgroupChatId: input.rejectedSubgroupChatId,
        replacementGeneration: generation,
        replacementAttempt: 1,
        runAt: completedAt,
        calendarStatus: event.calendarStatus,
        creatorIdentityId: event.actorIdentityId
      }
    });
    return { status: 'scheduled', event: getEvent(db, event.id)! };
  });
}

export function failClaimedRejectedEventChildReplacement(
  db: PluginDatabase,
  input: RejectedEventChildReplacementExpectation & {
    claim: EventCleanupClaim;
    failureReason: string;
    failedAt: string;
  }
): boolean {
  return db.transaction(() => {
    const event = getEvent(db, input.eventId);
    const claim = getEventCleanupClaim(db, input.eventId);
    if (
      !event ||
      event.scopeId !== input.scopeId ||
      event.eventStatus !== 'failed' ||
      event.groupLifecycleStatus !== 'cleanup_failed' ||
      event.calendarStatus !== 'included' ||
      event.subgroupChatId?.toLowerCase() !== input.rejectedSubgroupChatId.toLowerCase() ||
      event.updatedAt !== input.claim.expectedEventUpdatedAt ||
      !claim ||
      claim.claimId !== input.claim.claimId ||
      claim.expectedEventUpdatedAt !== event.updatedAt
    ) {
      return false;
    }
    const failedAt = nextEventRevisionTimestamp(event.updatedAt, new Date(input.failedAt));
    const failed = db.run(
      `UPDATE event_records
          SET error = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?`,
      input.failureReason,
      failedAt,
      event.id,
      event.updatedAt
    ).changes === 1;
    if (!failed || !releaseEventCleanupClaim(db, {
      eventId: event.id,
      claimId: input.claim.claimId
    })) {
      throw new Error(`Unable to release failed replacement claim ${input.claim.claimId}.`);
    }
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.legacy_child_replacement_dismantle_failed',
      metadata: {
        operationId: input.operationId,
        failureKind: input.failureKind,
        rejectedSubgroupChatId: input.rejectedSubgroupChatId,
        reason: input.failureReason,
        failedAt
      }
    });
    return true;
  });
}

export function markClaimedEventCleaned(db: PluginDatabase, input: {
  eventId: string;
  claimId: string;
  expectedUpdatedAt: string;
  cleanedAt: string;
}): boolean {
  return db.transaction(() => {
    const result = db.run(
      `UPDATE event_records
          SET event_status = 'completed',
              group_lifecycle_status = 'cleaned',
              cleaned_at = ?,
              error = NULL,
              provisioning_recovery_generation = NULL,
              provisioning_recovery_attempt = NULL,
              provisioning_recovery_next_run_at = NULL,
              provisioning_recovery_halted_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND (
            (event_status IN ('active', 'completed')
              AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed'))
            OR
            (event_status = 'failed'
              AND group_lifecycle_status = 'cleanup_failed'
              AND subgroup_chat_id IS NOT NULL
              AND provisioning_recovery_generation IS NULL
              AND provisioning_recovery_attempt IS NULL
              AND provisioning_recovery_next_run_at IS NULL
              AND provisioning_recovery_halted_at IS NULL)
          )
          AND updated_at = ?
          AND EXISTS (
            SELECT 1
              FROM event_cleanup_claims
             WHERE event_cleanup_claims.event_id = event_records.id
               AND event_cleanup_claims.claim_id = ?
               AND event_cleanup_claims.expected_event_updated_at = event_records.updated_at
          )`,
      input.cleanedAt,
      input.cleanedAt,
      input.eventId,
      input.expectedUpdatedAt,
      input.claimId
    );
    if (result.changes !== 1) {
      return false;
    }
    supersedeEventEditPresentationForTerminalTransition(db, input.eventId, input.cleanedAt);
    const released = releaseEventCleanupClaim(db, {
      eventId: input.eventId,
      claimId: input.claimId
    });
    if (!released) {
      throw new Error(`Cleanup claim ${input.claimId} disappeared while completing event ${input.eventId}.`);
    }
    return true;
  });
}

export function markClaimedEventCleanupFailed(db: PluginDatabase, input: {
  eventId: string;
  claimId: string;
  expectedUpdatedAt: string;
  reason: string;
  failedAt: string;
}): boolean {
  return db.transaction(() => {
    const result = db.run(
      `UPDATE event_records
          SET group_lifecycle_status = 'cleanup_failed',
              error = ?,
              updated_at = ?
        WHERE id = ?
          AND (
            (event_status IN ('active', 'completed')
              AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed'))
            OR
            (event_status = 'failed'
              AND group_lifecycle_status = 'cleanup_failed'
              AND subgroup_chat_id IS NOT NULL
              AND provisioning_recovery_generation IS NULL
              AND provisioning_recovery_attempt IS NULL
              AND provisioning_recovery_next_run_at IS NULL
              AND provisioning_recovery_halted_at IS NULL)
          )
          AND updated_at = ?
          AND EXISTS (
            SELECT 1
              FROM event_cleanup_claims
             WHERE event_cleanup_claims.event_id = event_records.id
               AND event_cleanup_claims.claim_id = ?
               AND event_cleanup_claims.expected_event_updated_at = event_records.updated_at
          )`,
      input.reason,
      input.failedAt,
      input.eventId,
      input.expectedUpdatedAt,
      input.claimId
    );
    if (result.changes !== 1) {
      return false;
    }
    const released = releaseEventCleanupClaim(db, {
      eventId: input.eventId,
      claimId: input.claimId
    });
    if (!released) {
      throw new Error(
        `Cleanup claim ${input.claimId} disappeared while recording event ${input.eventId} failure.`
      );
    }
    return true;
  });
}

export function markEventCancelled(db: PluginDatabase, input: {
  eventId: string;
  expectedUpdatedAt: string;
  cancelledAt: string;
  cancelledByWid: string;
  cancelledByLabel: string;
  calendarStatus?: Extract<EventCalendarStatus, 'cancelled' | 'hidden'> | undefined;
  reason?: string | undefined;
  deleteAnnouncementMessages?: boolean | undefined;
}): boolean {
  return db.transaction(() => {
    const result = db.run(
      `UPDATE event_records
          SET event_status = 'cancelled',
              calendar_status = ?,
              cancelled_at = ?,
              cancelled_by_wid = ?,
              cancelled_by_label = ?,
              cancel_reason = ?,
              error = NULL,
              updated_at = ?
        WHERE id = ?
          AND event_status = 'active'
          AND group_lifecycle_status = 'poll_open'
          AND updated_at = ?
          AND provisioning_recovery_generation IS NULL
          AND provisioning_recovery_attempt IS NULL
          AND provisioning_recovery_next_run_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM event_poll_replacements replacement
             WHERE replacement.event_id = event_records.id
               AND replacement.status NOT IN ('completed', 'aborted')
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_announcement_delivery_claims delivery
             WHERE delivery.event_id = event_records.id
               AND delivery.status = 'sending'
               AND delivery.lease_expires_at > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_cleanup_claims cleanup
             WHERE cleanup.event_id = event_records.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_edit_repairs repair
             WHERE repair.event_id = event_records.id
               AND repair.status = 'pending'
               AND repair.execution_claim_id IS NOT NULL
               AND repair.execution_lease_expires_at > ?
          )`,
      input.calendarStatus ?? 'cancelled',
      input.cancelledAt,
      input.cancelledByWid,
      input.cancelledByLabel,
      input.reason ?? null,
      input.cancelledAt,
      input.eventId,
      input.expectedUpdatedAt,
      input.cancelledAt,
      input.cancelledAt
    );
    if (result.changes !== 1) {
      return false;
    }
    supersedeEventEditPresentationForTerminalTransition(db, input.eventId, input.cancelledAt);
    if (input.deleteAnnouncementMessages) {
      initializeEventCancellationArtifactCleanup(db, input.eventId, input.cancelledAt);
    }
    return true;
  });
}

export function markClaimedEventCancelled(db: PluginDatabase, input: {
  eventId: string;
  claimId: string;
  expectedUpdatedAt: string;
  cancelledAt: string;
  cancelledByWid: string;
  cancelledByLabel: string;
  calendarStatus?: Extract<EventCalendarStatus, 'cancelled' | 'hidden'> | undefined;
  reason?: string | undefined;
  deleteAnnouncementMessages?: boolean | undefined;
}): boolean {
  return db.transaction(() => {
    const result = db.run(
      `UPDATE event_records
          SET event_status = 'cancelled',
              calendar_status = ?,
              cancelled_at = ?,
              cancelled_by_wid = ?,
              cancelled_by_label = ?,
              cancel_reason = ?,
              error = NULL,
              updated_at = ?
        WHERE id = ?
          AND event_status = 'active'
          AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed')
          AND updated_at = ?
          AND provisioning_recovery_generation IS NULL
          AND provisioning_recovery_attempt IS NULL
          AND provisioning_recovery_next_run_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM event_poll_replacements replacement
             WHERE replacement.event_id = event_records.id
               AND replacement.status NOT IN ('completed', 'aborted')
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_announcement_delivery_claims delivery
             WHERE delivery.event_id = event_records.id
               AND delivery.status = 'sending'
               AND delivery.lease_expires_at > ?
          )
          AND EXISTS (
            SELECT 1 FROM event_cleanup_claims cleanup
             WHERE cleanup.event_id = event_records.id
               AND cleanup.claim_id = ?
               AND cleanup.expected_event_updated_at = event_records.updated_at
          )`,
      input.calendarStatus ?? 'cancelled',
      input.cancelledAt,
      input.cancelledByWid,
      input.cancelledByLabel,
      input.reason ?? null,
      input.cancelledAt,
      input.eventId,
      input.expectedUpdatedAt,
      input.cancelledAt,
      input.claimId
    );
    if (result.changes !== 1) {
      return false;
    }
    supersedeEventEditPresentationForTerminalTransition(db, input.eventId, input.cancelledAt);
    if (input.deleteAnnouncementMessages) {
      initializeEventCancellationArtifactCleanup(db, input.eventId, input.cancelledAt);
    }
    if (!releaseEventCleanupClaim(db, { eventId: input.eventId, claimId: input.claimId })) {
      throw new Error(`Cancellation claim ${input.claimId} disappeared for event ${input.eventId}.`);
    }
    return true;
  });
}

function supersedeEventEditPresentationForTerminalTransition(
  db: PluginDatabase,
  eventId: string,
  transitionedAt: string
): void {
  db.run(
    `UPDATE event_announcement_delivery_claims
        SET status = 'superseded', lease_expires_at = NULL, error = NULL, updated_at = ?
      WHERE event_id = ?
        AND kind IN ('event_edit', 'calendar_hint')
        AND (
          status IN ('pending', 'uncertain')
          OR (status = 'sending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )`,
    transitionedAt,
    eventId,
    transitionedAt
  );
  db.run(
    `UPDATE event_edit_repairs
        SET status = 'completed', last_error = NULL, completed_at = ?, updated_at = ?,
            execution_claim_id = NULL, execution_lease_expires_at = NULL
      WHERE event_id = ? AND status = 'pending'`,
    transitionedAt,
    transitionedAt,
    eventId
  );
}

function initializeEventCancellationArtifactCleanup(
  db: PluginDatabase,
  eventId: string,
  initializedAt: string
): void {
  db.run(
    `UPDATE event_announcement_messages
        SET deletion_status = 'pending',
            deletion_attempt_count = 0,
            deletion_next_attempt_at = ?,
            deletion_submitted_at = NULL,
            deletion_confirmed_at = NULL,
            deletion_finalized_at = NULL,
            deletion_last_error = NULL,
            delete_error = NULL
      WHERE event_id = ?
        AND kind <> 'cancellation_notice'
        AND deleted_at IS NULL
        AND deletion_status IS NULL`,
    initializedAt,
    eventId
  );
}

export function beginEventArtifactDeletionCleanup(
  db: PluginDatabase,
  eventId: string,
  artifactIds: readonly string[],
  initializedAt: string
): number {
  let changed = 0;
  db.transaction(() => {
    for (const artifactId of new Set(artifactIds)) {
      changed += db.run(
        `UPDATE event_announcement_messages
            SET deletion_status = 'pending', deletion_attempt_count = 0,
                deletion_next_attempt_at = ?, deletion_submitted_at = NULL,
                deletion_confirmed_at = NULL, deletion_finalized_at = NULL,
                deletion_last_error = NULL, delete_error = NULL
          WHERE id = ? AND event_id = ? AND kind <> 'cancellation_notice'
            AND deleted_at IS NULL AND deletion_status IS NULL`,
        initializedAt,
        artifactId,
        eventId
      ).changes;
    }
  });
  return changed;
}

export function retryEventArtifactDeletionCleanup(
  db: PluginDatabase,
  eventId: string,
  retryAt: string
): number {
  return db.run(
    `UPDATE event_announcement_messages
        SET deletion_status = 'pending', deletion_attempt_count = 0,
            deletion_next_attempt_at = ?, deletion_submitted_at = NULL,
            deletion_confirmed_at = NULL, deletion_finalized_at = NULL,
            deletion_last_error = NULL, delete_error = NULL
      WHERE event_id = ?
        AND kind <> 'cancellation_notice'
        AND deleted_at IS NULL
        AND deletion_status IN ('pending', 'unconfirmed', 'rejected', 'failed')`,
    retryAt,
    eventId
  ).changes;
}

export function updateEventCalendarStatus(db: PluginDatabase, input: {
  eventId: string;
  calendarStatus: EventCalendarStatus;
  updatedAt: string;
}): void {
  db.run(
    `UPDATE event_records
        SET calendar_status = ?,
            updated_at = ?
      WHERE id = ?`,
    input.calendarStatus,
    input.updatedAt,
    input.eventId
  );
}

export function recordEventAnnouncementMessage(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementMessageKind;
  deliveryKey: string;
  chatId: string;
  messageId: string;
  createdAt?: string | undefined;
}): StoredEventAnnouncementMessage {
  const messageId = input.messageId.trim();
  if (!messageId) {
    throw new Error(`Cannot persist ${input.kind} announcement without a WhatsApp message id.`);
  }
  const now = input.createdAt ?? new Date().toISOString();
  const id = `evtmsg-${randomUUID()}`;
  db.run(
    `INSERT INTO event_announcement_messages (
        id, event_id, scope_id, kind, delivery_key, chat_id, message_id, created_at, deleted_at, delete_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(event_id, kind, delivery_key) DO UPDATE SET
        scope_id = excluded.scope_id,
        chat_id = excluded.chat_id,
        message_id = excluded.message_id,
        deleted_at = NULL,
        delete_error = NULL`,
    id,
    input.eventId,
    input.scopeId,
    input.kind,
    input.deliveryKey,
    input.chatId,
    messageId,
    now
  );
  const row = db.get<EventAnnouncementMessageRow>(
    `SELECT * FROM event_announcement_messages
      WHERE event_id = ? AND kind = ? AND delivery_key = ?
      LIMIT 1`,
    input.eventId,
    input.kind,
    input.deliveryKey
  );
  if (!row) {
    throw new Error(`Could not read persisted ${input.kind} WhatsApp message ${messageId}.`);
  }
  return eventAnnouncementMessageFromRow(row);
}

export function prepareEventCalendarHintDelivery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  deliveryKey: string;
  chatId: string;
  idempotencyKey: string;
  intent: EventCalendarHintDeliveryIntent;
  preparedAt?: string | undefined;
}): EventCalendarHintIntentPreparationResult {
  return db.transaction(() => {
    const deliveryKey = requiredEventOperationValue(input.deliveryKey, 'calendar-hint delivery key');
    const scopeId = requiredEventOperationValue(input.scopeId, 'calendar-hint scope id');
    const chatId = requiredEventOperationValue(input.chatId, 'calendar-hint chat id');
    const idempotencyKey = requiredEventOperationValue(
      input.idempotencyKey,
      'calendar-hint idempotency key'
    );
    const intent = normalizedEventCalendarHintDeliveryIntent(input.intent);
    const intentJson = JSON.stringify(intent);
    const now = input.preparedAt ?? new Date().toISOString();
    const existingMessage = db.get<{ id: string }>(
      `SELECT id
         FROM event_announcement_messages
        WHERE event_id = ?
          AND kind = 'calendar_hint'
          AND delivery_key = ?
        LIMIT 1`,
      input.eventId,
      deliveryKey
    );
    if (existingMessage) {
      return 'already_sent';
    }

    const currentEvent = db.get<{
      scope_id: string;
      updated_at: string;
      event_status: EventStatus;
      group_lifecycle_status: EventGroupLifecycleStatus;
    }>(
      `SELECT scope_id, updated_at, event_status, group_lifecycle_status
         FROM event_records
        WHERE id = ?`,
      input.eventId
    );
    if (
      !currentEvent ||
      currentEvent.scope_id !== scopeId ||
      currentEvent.updated_at !== intent.expectedEventUpdatedAt ||
      currentEvent.event_status === 'cancelled' ||
      currentEvent.group_lifecycle_status === 'cleaned'
    ) {
      db.run(
        `UPDATE event_announcement_delivery_claims
            SET status = 'superseded', lease_expires_at = NULL, error = NULL, updated_at = ?
          WHERE event_id = ?
            AND kind = 'calendar_hint'
            AND delivery_key = ?
            AND status <> 'sent'`,
        now,
        input.eventId,
        deliveryKey
      );
      return 'superseded';
    }

    const inserted = db.run(
      `INSERT INTO event_announcement_delivery_claims (
         event_id, kind, delivery_key, scope_id, chat_id, status, text, idempotency_key,
         lease_expires_at, message_id, error, calendar_hint_intent_json, claimed_at, updated_at
       ) VALUES (?, 'calendar_hint', ?, ?, ?, 'pending', NULL, ?, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT(event_id, kind, delivery_key) DO NOTHING`,
      input.eventId,
      deliveryKey,
      scopeId,
      chatId,
      idempotencyKey,
      intentJson,
      now,
      now
    );
    if (inserted.changes === 1) {
      return 'prepared';
    }

    const existing = getEventAnnouncementDeliveryClaim(
      db,
      input.eventId,
      'calendar_hint',
      deliveryKey
    );
    if (existing?.status === 'sent') {
      return 'already_sent';
    }
    if (existing?.status === 'superseded') {
      return 'superseded';
    }
    if (!existing) {
      return 'already_claimed';
    }
    if (
      existing.scopeId !== scopeId ||
      existing.chatId !== chatId ||
      existing.idempotencyKey !== idempotencyKey
    ) {
      throw new Error(
        `Persisted calendar_hint delivery ${deliveryKey} does not match the requested announcement intent.`
      );
    }
    if (existing.calendarHintIntent) {
      if (JSON.stringify(existing.calendarHintIntent) !== intentJson) {
        throw new Error(
          `Persisted calendar_hint delivery ${deliveryKey} does not match the requested calendar-hint intent.`
        );
      }
    } else if (!existing.text) {
      db.run(
        `UPDATE event_announcement_delivery_claims
            SET calendar_hint_intent_json = ?, updated_at = ?
          WHERE event_id = ?
            AND kind = 'calendar_hint'
            AND delivery_key = ?
            AND calendar_hint_intent_json IS NULL
            AND text IS NULL
            AND status IN ('pending', 'uncertain')`,
        intentJson,
        now,
        input.eventId,
        deliveryKey
      );
    }
    if (existing.status === 'sending') {
      const leaseExpiresAt = existing.leaseExpiresAt
        ? new Date(existing.leaseExpiresAt).getTime()
        : Number.NaN;
      if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now()) {
        return 'already_claimed';
      }
    }
    return 'prepared';
  });
}

export function deferEventCalendarHintDelivery(db: PluginDatabase, input: {
  eventId: string;
  deliveryKey: string;
  reason: string;
  updatedAt?: string | undefined;
}): boolean {
  const result = db.run(
    `UPDATE event_announcement_delivery_claims
        SET error = ?, lease_expires_at = NULL, updated_at = ?
      WHERE event_id = ?
        AND kind = 'calendar_hint'
        AND delivery_key = ?
        AND status = 'pending'`,
    input.reason.trim() || 'calendar hint is waiting for retry',
    input.updatedAt ?? new Date().toISOString(),
    input.eventId,
    input.deliveryKey
  );
  return result.changes === 1;
}

export function claimEventAnnouncementDelivery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  chatId: string;
  text: string;
  idempotencyKey: string;
  expectedEventUpdatedAt?: string | undefined;
  claimedAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
}): EventAnnouncementDeliveryClaimResult {
  return db.transaction(() => {
    const existingMessage = db.get<{ id: string }>(
      `SELECT id
         FROM event_announcement_messages
        WHERE event_id = ?
          AND kind = ?
          AND delivery_key = ?
        LIMIT 1`,
      input.eventId,
      input.kind,
      input.deliveryKey
    );
    if (existingMessage) {
      return 'already_sent';
    }

    const intent = normalizedEventAnnouncementIntent(input);
    const now = input.claimedAt ?? new Date().toISOString();
    const currentEvent = db.get<{
      updated_at: string;
      event_status: EventStatus;
      group_lifecycle_status: EventGroupLifecycleStatus;
    }>(
      `SELECT updated_at, event_status, group_lifecycle_status
         FROM event_records
        WHERE id = ?`,
      input.eventId
    );
    if (
      !currentEvent ||
      currentEvent.event_status === 'cancelled' ||
      currentEvent.group_lifecycle_status === 'cleaned' ||
      (input.expectedEventUpdatedAt && currentEvent.updated_at !== input.expectedEventUpdatedAt)
    ) {
      db.run(
        `UPDATE event_announcement_delivery_claims
            SET status = 'superseded', lease_expires_at = NULL, error = NULL, updated_at = ?
          WHERE event_id = ? AND kind = ? AND delivery_key = ? AND status <> 'sent'`,
        now,
        input.eventId,
        intent.kind,
        intent.deliveryKey
      );
      return 'superseded';
    }
    const mutationFence = db.get<{ fenced: number }>(
      `SELECT (
          EXISTS (
            SELECT 1 FROM event_poll_replacements replacement
             WHERE replacement.event_id = ?
               AND replacement.status NOT IN ('completed', 'aborted')
          )
          OR EXISTS (
            SELECT 1 FROM event_cleanup_claims cleanup
             WHERE cleanup.event_id = ?
          )
        ) AS fenced`,
      input.eventId,
      input.eventId
    );
    if (Boolean(mutationFence?.fenced)) {
      // The mutation may still fail and release its fence. Preserve the frozen
      // intent so the same-key delivery can resume instead of losing it.
      return 'already_claimed';
    }
    const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
      new Date(now).getTime() + EVENT_ANNOUNCEMENT_DELIVERY_LEASE_MS
    ).toISOString();
    const inserted = db.run(
      `INSERT INTO event_announcement_delivery_claims (
         event_id, kind, delivery_key, scope_id, chat_id, status, text, idempotency_key,
         lease_expires_at, message_id, error, claimed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'sending', ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(event_id, kind, delivery_key) DO NOTHING`,
      input.eventId,
      intent.kind,
      intent.deliveryKey,
      intent.scopeId,
      intent.chatId,
      intent.text,
      intent.idempotencyKey,
      leaseExpiresAt,
      now,
      now
    );
    if (inserted.changes === 1) {
      return 'claimed';
    }
    const existingClaim = getEventAnnouncementDeliveryClaim(db, input.eventId, intent.kind, intent.deliveryKey);
    if (existingClaim?.status === 'sent') {
      return 'already_sent';
    }
    if (!existingClaim) {
      return 'already_claimed';
    }
    const materializesPreparedCalendarHint =
      existingClaim.kind === 'calendar_hint' &&
      !existingClaim.text &&
      Boolean(existingClaim.calendarHintIntent);
    if (
      existingClaim.scopeId !== intent.scopeId ||
      existingClaim.chatId !== intent.chatId ||
      (!materializesPreparedCalendarHint && existingClaim.text !== intent.text) ||
      existingClaim.idempotencyKey !== intent.idempotencyKey
    ) {
      throw new Error(
        `Persisted ${intent.kind} delivery ${intent.deliveryKey} does not match the requested announcement intent.`
      );
    }

    const reacquired = db.run(
      `UPDATE event_announcement_delivery_claims
          SET status = 'sending',
              text = ?,
              idempotency_key = ?,
              lease_expires_at = ?,
              error = NULL,
              claimed_at = ?,
              updated_at = ?
        WHERE event_id = ?
          AND kind = ?
          AND delivery_key = ?
          AND (
            status IN ('pending', 'uncertain')
            OR (status = 'sending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )`,
      intent.text,
      intent.idempotencyKey,
      leaseExpiresAt,
      now,
      now,
      input.eventId,
      intent.kind,
      intent.deliveryKey,
      now
    );
    return reacquired.changes === 1 ? 'claimed' : 'already_claimed';
  });
}

export function supersedeEventAnnouncementDelivery(db: PluginDatabase, input: {
  eventId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  updatedAt?: string | undefined;
}): boolean {
  return db.transaction(() => {
    const existingMessage = db.get<{ id: string }>(
      `SELECT id FROM event_announcement_messages
        WHERE event_id = ? AND kind = ? AND delivery_key = ?
        LIMIT 1`,
      input.eventId,
      input.kind,
      input.deliveryKey
    );
    if (existingMessage) {
      return true;
    }
    const result = db.run(
      `UPDATE event_announcement_delivery_claims
          SET status = 'superseded', lease_expires_at = NULL, error = NULL, updated_at = ?
        WHERE event_id = ? AND kind = ? AND delivery_key = ? AND status <> 'sent'`,
      input.updatedAt ?? new Date().toISOString(),
      input.eventId,
      input.kind,
      input.deliveryKey
    );
    if (result.changes === 1) {
      return true;
    }
    return getEventAnnouncementDeliveryClaim(db, input.eventId, input.kind, input.deliveryKey)?.status === 'sent';
  });
}

export function completeEventAnnouncementDelivery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  chatId: string;
  messageId: string;
  completedAt?: string | undefined;
}): StoredEventAnnouncementMessage {
  const messageId = input.messageId.trim();
  if (!messageId) {
    throw new Error(`Cannot complete ${input.kind} delivery without a WhatsApp message id.`);
  }
  return db.transaction(() => {
    const existing = db.get<EventAnnouncementMessageRow>(
      `SELECT * FROM event_announcement_messages
        WHERE event_id = ? AND kind = ? AND delivery_key = ?
        LIMIT 1`,
      input.eventId,
      input.kind,
      input.deliveryKey
    );
    if (existing) {
      return eventAnnouncementMessageFromRow(existing);
    }
    const current = getEventAnnouncementDeliveryClaim(db, input.eventId, input.kind, input.deliveryKey);
    if (!current || current.status !== 'sending') {
      throw new Error(
        `Cannot complete ${input.kind} delivery for event ${input.eventId} from ${current?.status ?? 'missing'} state.`
      );
    }
    const completedAt = input.completedAt ?? new Date().toISOString();
    const message = recordEventAnnouncementMessage(db, {
      eventId: input.eventId,
      scopeId: input.scopeId,
      kind: input.kind,
      deliveryKey: input.deliveryKey,
      chatId: input.chatId,
      messageId,
      createdAt: completedAt
    });
    const updated = db.run(
      `UPDATE event_announcement_delivery_claims
          SET status = 'sent',
              scope_id = ?,
              chat_id = ?,
              message_id = ?,
              lease_expires_at = NULL,
              error = NULL,
              updated_at = ?
        WHERE event_id = ?
          AND kind = ?
          AND delivery_key = ?
          AND status = 'sending'`,
      input.scopeId,
      input.chatId,
      messageId,
      completedAt,
      input.eventId,
      input.kind,
      input.deliveryKey
    );
    if (updated.changes !== 1) {
      throw new Error(`Event ${input.eventId} changed while completing ${input.kind} delivery.`);
    }
    return message;
  });
}

export function markEventAnnouncementDeliveryUncertain(db: PluginDatabase, input: {
  eventId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  reason: string;
  updatedAt?: string | undefined;
}): void {
  const updated = db.run(
      `UPDATE event_announcement_delivery_claims
        SET status = 'uncertain',
            lease_expires_at = NULL,
            error = ?,
            updated_at = ?
      WHERE event_id = ?
        AND kind = ?
        AND delivery_key = ?
        AND status = 'sending'`,
    input.reason,
    input.updatedAt ?? new Date().toISOString(),
    input.eventId,
    input.kind,
    input.deliveryKey
  );
  if (updated.changes !== 1) {
    const current = getEventAnnouncementDeliveryClaim(db, input.eventId, input.kind, input.deliveryKey);
    if (current?.status === 'sent') {
      return;
    }
    throw new Error(
      `Cannot mark ${input.kind} delivery for event ${input.eventId} uncertain from its current state.`
    );
  }
}

export function getEventAnnouncementDeliveryClaim(
  db: PluginDatabase,
  eventId: string,
  kind: EventAnnouncementDeliveryKind,
  deliveryKey: string
): StoredEventAnnouncementDeliveryClaim | undefined {
  const row = db.get<EventAnnouncementDeliveryClaimRow>(
    `SELECT *
       FROM event_announcement_delivery_claims
      WHERE event_id = ? AND kind = ? AND delivery_key = ?`,
    eventId,
    kind,
    deliveryKey
  );
  return row ? eventAnnouncementDeliveryClaimFromRow(row) : undefined;
}

export function listRecoverableEventAnnouncementDeliveries(
  db: PluginDatabase,
  input: { kind?: EventAnnouncementDeliveryKind | undefined } = {}
): StoredEventAnnouncementDeliveryClaim[] {
  const rows = input.kind
    ? db.all<EventAnnouncementDeliveryClaimRow>(
      `SELECT * FROM event_announcement_delivery_claims
        WHERE kind = ? AND status IN ('pending', 'sending', 'uncertain')
        ORDER BY updated_at ASC, event_id ASC, delivery_key ASC`,
      input.kind
    )
    : db.all<EventAnnouncementDeliveryClaimRow>(
      `SELECT * FROM event_announcement_delivery_claims
        WHERE status IN ('pending', 'sending', 'uncertain')
        ORDER BY updated_at ASC, event_id ASC, kind ASC, delivery_key ASC`
    );
  return rows.map(eventAnnouncementDeliveryClaimFromRow);
}

export function getEventEditRepair(
  db: PluginDatabase,
  operationId: string
): StoredEventEditRepair | undefined {
  const row = db.get<EventEditRepairRow>(
    'SELECT * FROM event_edit_repairs WHERE operation_id = ?',
    operationId
  );
  return row ? eventEditRepairFromRow(row) : undefined;
}

export function listPendingEventEditRepairs(
  db: PluginDatabase,
  input: { operationId?: string | undefined } = {}
): StoredEventEditRepair[] {
  const rows = input.operationId
    ? db.all<EventEditRepairRow>(
      `SELECT * FROM event_edit_repairs
        WHERE status = 'pending' AND operation_id = ?
        ORDER BY created_at ASC, operation_id ASC`,
      input.operationId
    )
    : db.all<EventEditRepairRow>(
      `SELECT * FROM event_edit_repairs
        WHERE status = 'pending'
        ORDER BY created_at ASC, operation_id ASC`
    );
  return rows.map(eventEditRepairFromRow);
}

export function claimEventEditRepairExecution(db: PluginDatabase, input: {
  operationId: string;
  claimedAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
}): EventEditRepairExecutionClaim | undefined {
  const claimedAt = input.claimedAt ?? new Date().toISOString();
  const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
    new Date(claimedAt).getTime() + EVENT_EDIT_REPAIR_EXECUTION_LEASE_MS
  ).toISOString();
  const claimId = `evteditrepair-${randomUUID()}`;
  const claimed = db.run(
    `UPDATE event_edit_repairs
        SET execution_claim_id = ?, execution_lease_expires_at = ?, updated_at = ?
      WHERE operation_id = ?
        AND status = 'pending'
        AND (
          execution_claim_id IS NULL
          OR execution_lease_expires_at IS NULL
          OR execution_lease_expires_at <= ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_cleanup_claims cleanup
           WHERE cleanup.event_id = event_edit_repairs.event_id
        )`,
    claimId,
    leaseExpiresAt,
    claimedAt,
    input.operationId,
    claimedAt
  );
  return claimed.changes === 1
    ? { operationId: input.operationId, claimId, leaseExpiresAt }
    : undefined;
}

export function renewEventEditRepairExecution(db: PluginDatabase, input: {
  operationId: string;
  claimId: string;
  leaseExpiresAt: string;
}): boolean {
  return db.run(
    `UPDATE event_edit_repairs
        SET execution_lease_expires_at = ?
      WHERE operation_id = ?
        AND status = 'pending'
        AND execution_claim_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM event_cleanup_claims cleanup
           WHERE cleanup.event_id = event_edit_repairs.event_id
        )`,
    input.leaseExpiresAt,
    input.operationId,
    input.claimId
  ).changes === 1;
}

export function releaseEventEditRepairExecution(db: PluginDatabase, input: {
  operationId: string;
  claimId: string;
}): boolean {
  return db.run(
    `UPDATE event_edit_repairs
        SET execution_claim_id = NULL, execution_lease_expires_at = NULL
      WHERE operation_id = ? AND execution_claim_id = ?`,
    input.operationId,
    input.claimId
  ).changes === 1;
}

export function getEventEditRepairExecutionLeaseExpiresAt(
  db: PluginDatabase,
  eventId: string,
  now: string = new Date().toISOString()
): string | undefined {
  const row = db.get<{ lease_expires_at: string | null }>(
    `SELECT MAX(execution_lease_expires_at) AS lease_expires_at
       FROM event_edit_repairs
      WHERE event_id = ?
        AND status = 'pending'
        AND execution_claim_id IS NOT NULL
        AND execution_lease_expires_at > ?`,
    eventId,
    now
  );
  return row?.lease_expires_at ?? undefined;
}

export function completeEventEditRepair(db: PluginDatabase, input: {
  operationId: string;
  executionClaimId: string;
  completedAt?: string | undefined;
}): boolean {
  const completedAt = input.completedAt ?? new Date().toISOString();
  return db.run(
    `UPDATE event_edit_repairs
        SET status = 'completed', last_error = NULL, completed_at = ?, updated_at = ?,
            execution_claim_id = NULL, execution_lease_expires_at = NULL
      WHERE operation_id = ? AND status = 'pending' AND execution_claim_id = ?`,
    completedAt,
    completedAt,
    input.operationId,
    input.executionClaimId
  ).changes === 1;
}

export function markEventEditRepairPending(db: PluginDatabase, input: {
  operationId: string;
  executionClaimId: string;
  reason: string;
  updatedAt?: string | undefined;
}): boolean {
  return db.run(
    `UPDATE event_edit_repairs
        SET last_error = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'pending' AND execution_claim_id = ?`,
    input.reason,
    input.updatedAt ?? new Date().toISOString(),
    input.operationId,
    input.executionClaimId
  ).changes === 1;
}

export function markEventCalendarPublicationDirty(db: PluginDatabase, input: {
  scopeId: string;
  calendarId: string;
  updatedAt?: string | undefined;
}): number {
  const scopeId = input.scopeId.trim();
  const calendarId = input.calendarId.trim();
  if (!scopeId || !calendarId) {
    throw new Error('Calendar publication dirtiness requires a scope and calendar id.');
  }
  db.run(
    `INSERT INTO event_calendar_publication_generations (
       scope_id, calendar_id, requested_generation, local_generation,
       completed_generation, lease_token, lease_generation, lease_expires_at,
       failure_count, next_attempt_at, updated_at
     ) VALUES (?, ?, 1, 0, 0, NULL, NULL, NULL, 0, NULL, ?)
     ON CONFLICT(scope_id, calendar_id) DO UPDATE SET
       requested_generation = event_calendar_publication_generations.requested_generation + 1,
       failure_count = 0,
       next_attempt_at = NULL,
       updated_at = excluded.updated_at`,
    scopeId,
    calendarId,
    input.updatedAt ?? new Date().toISOString()
  );
  const state = getEventCalendarPublicationGeneration(db, scopeId, calendarId);
  if (!state) {
    throw new Error(`Calendar publication generation was not created for ${scopeId}/${calendarId}.`);
  }
  return state.requestedGeneration;
}

export function getEventCalendarPublicationGeneration(
  db: PluginDatabase,
  scopeId: string,
  calendarId: string
): StoredEventCalendarPublicationGeneration | undefined {
  const row = db.get<EventCalendarPublicationGenerationRow>(
    `SELECT * FROM event_calendar_publication_generations
      WHERE scope_id = ? AND calendar_id = ?`,
    scopeId,
    calendarId
  );
  return row ? eventCalendarPublicationGenerationFromRow(row) : undefined;
}

export function listEventCalendarPublicationGenerations(
  db: PluginDatabase
): StoredEventCalendarPublicationGeneration[] {
  return db.all<EventCalendarPublicationGenerationRow>(
    `SELECT * FROM event_calendar_publication_generations
      ORDER BY scope_id ASC, calendar_id ASC`
  ).map(eventCalendarPublicationGenerationFromRow);
}

/**
 * Reconciles the render/target configuration revision with the durable
 * publication generation. This is intentionally DB-backed so configuration
 * changes discovered after a crash cannot bypass publication.
 */
export function ensureEventCalendarPublicationConfiguration(db: PluginDatabase, input: {
  scopeId: string;
  calendarId: string;
  fingerprint: string;
  updatedAt?: string | undefined;
}): { generation: number; changed: boolean } {
  const scopeId = input.scopeId.trim();
  const calendarId = input.calendarId.trim();
  const fingerprint = input.fingerprint.trim().toLowerCase();
  if (!scopeId || !calendarId || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('Calendar publication configuration requires a scope, calendar id, and SHA-256 fingerprint.');
  }
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  return db.transaction(() => {
    const state = getEventCalendarPublicationGeneration(db, scopeId, calendarId);
    if (!state) {
      db.run(
        `INSERT INTO event_calendar_publication_generations (
           scope_id, calendar_id, requested_generation, local_generation,
           completed_generation, lease_token, lease_generation, lease_expires_at,
           failure_count, next_attempt_at, requested_config_fingerprint, updated_at
         ) VALUES (?, ?, 1, 0, 0, NULL, NULL, NULL, 0, NULL, ?, ?)`,
        scopeId,
        calendarId,
        fingerprint,
        updatedAt
      );
      return { generation: 1, changed: true };
    }
    if (state.requestedConfigFingerprint === fingerprint) {
      return { generation: state.requestedGeneration, changed: false };
    }
    const attachToInitialDirtyGeneration =
      state.requestedConfigFingerprint === undefined &&
      state.completedGeneration === 0 &&
      state.documentGeneration === undefined;
    db.run(
      `UPDATE event_calendar_publication_generations
          SET requested_generation = requested_generation + ?,
              requested_config_fingerprint = ?,
              failure_count = 0,
              next_attempt_at = NULL,
              updated_at = ?
        WHERE scope_id = ? AND calendar_id = ?`,
      attachToInitialDirtyGeneration ? 0 : 1,
      fingerprint,
      updatedAt,
      scopeId,
      calendarId
    );
    const updated = getEventCalendarPublicationGeneration(db, scopeId, calendarId);
    if (!updated) {
      throw new Error(`Calendar publication configuration was not persisted for ${scopeId}/${calendarId}.`);
    }
    return { generation: updated.requestedGeneration, changed: true };
  });
}

export function listDirtyEventCalendarPublications(
  db: PluginDatabase,
  input: { readyAt?: string | undefined } = {}
): StoredEventCalendarPublicationGeneration[] {
  const rows = input.readyAt
    ? db.all<EventCalendarPublicationGenerationRow>(
      `SELECT * FROM event_calendar_publication_generations
        WHERE completed_generation < requested_generation
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY scope_id ASC, calendar_id ASC`,
      input.readyAt
    )
    : db.all<EventCalendarPublicationGenerationRow>(
      `SELECT * FROM event_calendar_publication_generations
        WHERE completed_generation < requested_generation
        ORDER BY scope_id ASC, calendar_id ASC`
    );
  return rows.map(eventCalendarPublicationGenerationFromRow);
}

export function claimEventCalendarPublication(db: PluginDatabase, input: {
  scopeId: string;
  calendarId: string;
  leaseToken: string;
  expectedConfigFingerprint?: string | undefined;
  now?: string | undefined;
  leaseExpiresAt?: string | undefined;
}): EventCalendarPublicationClaimResult {
  const now = input.now ?? new Date().toISOString();
  const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
    new Date(now).getTime() + EVENT_CALENDAR_PUBLICATION_LEASE_MS
  ).toISOString();
  return db.transaction(() => {
    const state = getEventCalendarPublicationGeneration(db, input.scopeId, input.calendarId);
    if (!state) {
      throw new Error(`Calendar publication generation is missing for ${input.scopeId}/${input.calendarId}.`);
    }
    if (state.completedGeneration >= state.requestedGeneration) {
      return { status: 'clean', state };
    }
    const claimed = db.run(
      `UPDATE event_calendar_publication_generations
          SET lease_token = ?,
              lease_generation = requested_generation,
              lease_expires_at = ?,
              updated_at = ?
        WHERE scope_id = ?
          AND calendar_id = ?
          AND completed_generation < requested_generation
          AND (? IS NULL OR requested_config_fingerprint = ?)
          AND (
            lease_token IS NULL
            OR lease_expires_at <= ?
            OR lease_token = ?
          )`,
      input.leaseToken,
      leaseExpiresAt,
      now,
      input.scopeId,
      input.calendarId,
      input.expectedConfigFingerprint ?? null,
      input.expectedConfigFingerprint ?? null,
      now,
      input.leaseToken
    );
    const current = getEventCalendarPublicationGeneration(db, input.scopeId, input.calendarId);
    if (
      claimed.changes === 1 &&
      current?.leaseToken === input.leaseToken &&
      current.leaseGeneration === current.requestedGeneration &&
      current.leaseExpiresAt
    ) {
      return {
        status: 'claimed',
        claim: {
          scopeId: current.scopeId,
          calendarId: current.calendarId,
          generation: current.requestedGeneration,
          leaseToken: input.leaseToken,
          leaseExpiresAt: current.leaseExpiresAt
        }
      };
    }
    if (
      input.expectedConfigFingerprint !== undefined &&
      current?.requestedConfigFingerprint !== input.expectedConfigFingerprint
    ) {
      if (!current) {
        throw new Error(`Calendar publication generation disappeared for ${input.scopeId}/${input.calendarId}.`);
      }
      return { status: 'configuration_changed', state: current };
    }
    if (!current?.leaseExpiresAt) {
      throw new Error(`Calendar publication lease state is inconsistent for ${input.scopeId}/${input.calendarId}.`);
    }
    return { status: 'busy', retryAt: current.leaseExpiresAt };
  });
}

export function renewEventCalendarPublicationClaim(db: PluginDatabase, input: {
  claim: EventCalendarPublicationClaim;
  leaseExpiresAt: string;
  updatedAt?: string | undefined;
}): boolean {
  return db.run(
    `UPDATE event_calendar_publication_generations
        SET lease_expires_at = ?, updated_at = ?
      WHERE scope_id = ?
        AND calendar_id = ?
        AND lease_token = ?
        AND lease_generation = ?
        AND requested_generation = ?`,
    input.leaseExpiresAt,
    input.updatedAt ?? new Date().toISOString(),
    input.claim.scopeId,
    input.claim.calendarId,
    input.claim.leaseToken,
    input.claim.generation,
    input.claim.generation
  ).changes === 1;
}

/**
 * Freezes the exact rendered document for a claimed generation. Retries must
 * reuse this snapshot so an equal generation can never carry different bytes.
 */
export function storeEventCalendarPublicationDocument(db: PluginDatabase, input: {
  claim: EventCalendarPublicationClaim;
  configFingerprint: string;
  calendarJson: string;
  eventsJson: string;
  body: string;
  generatedAt: string;
  eventCount: number;
}): boolean {
  if (!Number.isInteger(input.eventCount) || input.eventCount < 0) {
    throw new Error('Calendar publication document event count must be a non-negative integer.');
  }
  const sha256 = createHash('sha256').update(input.body).digest('hex');
  return db.run(
    `UPDATE event_calendar_publication_generations
        SET document_generation = ?,
            document_body = ?,
            document_sha256 = ?,
            document_config_fingerprint = ?,
            document_calendar_json = ?,
            document_events_json = ?,
            document_generated_at = ?,
            document_event_count = ?,
            updated_at = ?
      WHERE scope_id = ?
        AND calendar_id = ?
        AND lease_token = ?
        AND lease_generation = ?
        AND requested_generation = ?
        AND requested_config_fingerprint = ?`,
    input.claim.generation,
    input.body,
    sha256,
    input.configFingerprint,
    input.calendarJson,
    input.eventsJson,
    input.generatedAt,
    input.eventCount,
    new Date().toISOString(),
    input.claim.scopeId,
    input.claim.calendarId,
    input.claim.leaseToken,
    input.claim.generation,
    input.claim.generation,
    input.configFingerprint
  ).changes === 1;
}

export function commitEventCalendarLocalGeneration(
  db: PluginDatabase,
  claim: EventCalendarPublicationClaim,
  commit: () => void
): boolean {
  return db.transaction(() => {
    if (!eventCalendarPublicationClaimIsCurrent(db, claim)) {
      return false;
    }
    commit();
    return db.run(
      `UPDATE event_calendar_publication_generations
          SET local_generation = ?, updated_at = ?
        WHERE scope_id = ?
          AND calendar_id = ?
          AND lease_token = ?
          AND lease_generation = ?
          AND requested_generation = ?`,
      claim.generation,
      new Date().toISOString(),
      claim.scopeId,
      claim.calendarId,
      claim.leaseToken,
      claim.generation,
      claim.generation
    ).changes === 1;
  });
}

export function finishEventCalendarPublicationAttempt(db: PluginDatabase, input: {
  claim: EventCalendarPublicationClaim;
  generatedAt: string;
  generatedEventCount: number;
  publication?: CalendarPublicationOutcome | undefined;
  completed: boolean;
}): boolean {
  return db.transaction(() => {
    if (!eventCalendarPublicationClaimIsCurrent(db, input.claim)) {
      return false;
    }
    const state = getEventCalendarPublicationGeneration(
      db,
      input.claim.scopeId,
      input.claim.calendarId
    );
    if (!state) {
      return false;
    }
    const now = new Date();
    const nextFailureCount = input.completed ? 0 : state.failureCount + 1;
    const retryDelay = EVENT_CALENDAR_PUBLICATION_RETRY_DELAYS_MS[
      Math.min(nextFailureCount - 1, EVENT_CALENDAR_PUBLICATION_RETRY_DELAYS_MS.length - 1)
    ];
    const nextAttemptAt = input.completed || retryDelay === undefined
      ? null
      : new Date(now.getTime() + retryDelay).toISOString();
    recordCalendarPublicationStatus(db, {
      scopeId: input.claim.scopeId,
      calendarId: input.claim.calendarId,
      generation: input.claim.generation,
      generatedAt: input.generatedAt,
      generatedEventCount: input.generatedEventCount,
      ...(input.publication ? { publication: input.publication } : {})
    });
    const result = db.run(
      `UPDATE event_calendar_publication_generations
          SET completed_generation = CASE
                WHEN ? = 1 THEN ?
                ELSE completed_generation
              END,
              lease_token = NULL,
              lease_generation = NULL,
              lease_expires_at = NULL,
              failure_count = ?,
              next_attempt_at = ?,
              completed_config_fingerprint = CASE
                WHEN ? = 1 THEN document_config_fingerprint
                ELSE completed_config_fingerprint
              END,
              updated_at = ?
        WHERE scope_id = ?
          AND calendar_id = ?
          AND lease_token = ?
          AND lease_generation = ?
          AND requested_generation = ?`,
      input.completed ? 1 : 0,
      input.claim.generation,
      nextFailureCount,
      nextAttemptAt,
      input.completed ? 1 : 0,
      now.toISOString(),
      input.claim.scopeId,
      input.claim.calendarId,
      input.claim.leaseToken,
      input.claim.generation,
      input.claim.generation
    );
    return result.changes === 1;
  });
}

export function releaseEventCalendarPublicationClaim(
  db: PluginDatabase,
  claim: EventCalendarPublicationClaim
): boolean {
  return db.run(
    `UPDATE event_calendar_publication_generations
        SET lease_token = NULL,
            lease_generation = NULL,
            lease_expires_at = NULL,
            updated_at = ?
      WHERE scope_id = ?
        AND calendar_id = ?
        AND lease_token = ?
        AND lease_generation = ?`,
    new Date().toISOString(),
    claim.scopeId,
    claim.calendarId,
    claim.leaseToken,
    claim.generation
  ).changes === 1;
}

export function eventCalendarPublicationClaimIsCurrent(
  db: PluginDatabase,
  claim: EventCalendarPublicationClaim
): boolean {
  const state = getEventCalendarPublicationGeneration(db, claim.scopeId, claim.calendarId);
  return Boolean(
    state &&
    state.leaseToken === claim.leaseToken &&
    state.leaseGeneration === claim.generation &&
    state.requestedGeneration === claim.generation
  );
}

export function listEventAnnouncementMessages(db: PluginDatabase, eventId: string, input: {
  includeDeleted?: boolean | undefined;
} = {}): StoredEventAnnouncementMessage[] {
  const rows = input.includeDeleted
    ? db.all<EventAnnouncementMessageRow>(
      `SELECT * FROM event_announcement_messages
        WHERE event_id = ?
        ORDER BY created_at ASC, id ASC`,
      eventId
    )
    : db.all<EventAnnouncementMessageRow>(
      `SELECT * FROM event_announcement_messages
        WHERE event_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
      eventId
    );
  return rows.map(eventAnnouncementMessageFromRow);
}

export function listDueEventCancellationArtifacts(
  db: PluginDatabase,
  now: string,
  eventId?: string | undefined
): StoredEventAnnouncementMessage[] {
  return db.all<EventAnnouncementMessageRow>(
    `SELECT * FROM event_announcement_messages
      WHERE deletion_status IN ('pending', 'unconfirmed')
        AND deletion_next_attempt_at IS NOT NULL
        AND deletion_next_attempt_at <= ?
        AND (? IS NULL OR event_id = ?)
      ORDER BY deletion_next_attempt_at ASC, created_at ASC, id ASC`,
    now,
    eventId ?? null,
    eventId ?? null
  ).map(eventAnnouncementMessageFromRow);
}

export function listEventCancellationCleanupCandidates(
  db: PluginDatabase
): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT DISTINCT event_records.*
       FROM event_records
       JOIN event_announcement_messages artifact ON artifact.event_id = event_records.id
      WHERE (event_records.event_status = 'cancelled' OR event_records.origin = 'unplanned')
        AND artifact.deletion_status IN ('pending', 'unconfirmed')
        AND artifact.deletion_next_attempt_at IS NOT NULL
      ORDER BY event_records.cancelled_at ASC, event_records.id ASC`,
  ).map(eventFromRow);
}

export function listEventCancellationNoticeCandidates(
  db: PluginDatabase,
  now: string
): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT DISTINCT event_records.*
       FROM event_records
       JOIN event_announcement_messages artifact ON artifact.event_id = event_records.id
      WHERE event_records.event_status = 'cancelled'
        AND event_records.lifecycle_complete_at > ?
        AND artifact.deletion_status IN ('rejected', 'failed', 'unconfirmed')
        AND artifact.deletion_next_attempt_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM event_announcement_messages notice
           WHERE notice.event_id = event_records.id
             AND notice.kind = 'cancellation_notice'
        )
      ORDER BY event_records.cancelled_at ASC, event_records.id ASC`,
    now
  ).map(eventFromRow);
}

export function claimEventCancellationArtifactDeletion(db: PluginDatabase, input: {
  artifactId: string;
  expectedNextAttemptAt: string;
  claimedAt: string;
  claimedUntil: string;
}): boolean {
  return db.run(
    `UPDATE event_announcement_messages
        SET deletion_next_attempt_at = ?
      WHERE id = ?
        AND deletion_status IN ('pending', 'unconfirmed')
        AND deletion_next_attempt_at = ?
        AND deletion_next_attempt_at <= ?`,
    input.claimedUntil,
    input.artifactId,
    input.expectedNextAttemptAt,
    input.claimedAt
  ).changes === 1;
}

export function recordEventCancellationArtifactDeletionOutcome(db: PluginDatabase, input: {
  artifactId: string;
  result: MessageDeletionResult | { status: 'error'; reason: string };
  attemptedAt: string;
  claimExpiresAt: string;
}): StoredEventAnnouncementMessage | undefined {
  return db.transaction(() => {
    const row = db.get<EventAnnouncementMessageRow>(
      `SELECT * FROM event_announcement_messages WHERE id = ?`,
      input.artifactId
    );
    if (!row || row.deletion_next_attempt_at !== input.claimExpiresAt ||
      !row.deletion_status || row.deletion_status === 'confirmed' ||
      row.deletion_status === 'rejected' || row.deletion_status === 'failed') {
      return row ? eventAnnouncementMessageFromRow(row) : undefined;
    }
    const attempt = Number(row.deletion_attempt_count ?? 0) + 1;
    if (input.result.status === 'confirmed') {
      db.run(
        `UPDATE event_announcement_messages
            SET deletion_status = 'confirmed', deletion_attempt_count = ?,
                deletion_next_attempt_at = NULL, deletion_submitted_at = COALESCE(deletion_submitted_at, ?),
                deletion_confirmed_at = ?, deletion_finalized_at = ?, deletion_last_error = NULL,
                deleted_at = ?, delete_error = NULL
          WHERE id = ? AND deletion_status IN ('pending', 'unconfirmed')
            AND deletion_next_attempt_at = ?`,
        attempt,
        input.attemptedAt,
        input.attemptedAt,
        input.attemptedAt,
        input.attemptedAt,
        input.artifactId,
        input.claimExpiresAt
      );
    } else if (input.result.status === 'rejected') {
      db.run(
        `UPDATE event_announcement_messages
            SET deletion_status = 'rejected', deletion_attempt_count = ?, deletion_next_attempt_at = NULL,
                deletion_finalized_at = ?, deletion_last_error = ?, delete_error = ?
          WHERE id = ? AND deletion_status IN ('pending', 'unconfirmed')
            AND deletion_next_attempt_at = ?`,
        attempt,
        input.attemptedAt,
        input.result.reason,
        input.result.reason,
        input.artifactId,
        input.claimExpiresAt
      );
    } else {
      const reason = input.result.status === 'error'
        ? input.result.reason
        : 'Deletion submitted; provider confirmation pending.';
      const finalAttempt = attempt >= 3;
      const nextAttemptAt = finalAttempt
        ? null
        : new Date(new Date(input.attemptedAt).getTime() + (attempt === 1 ? 60_000 : 4 * 60_000)).toISOString();
      db.run(
        `UPDATE event_announcement_messages
            SET deletion_status = ?, deletion_attempt_count = ?, deletion_next_attempt_at = ?,
                deletion_submitted_at = CASE WHEN ? = 'unconfirmed' THEN COALESCE(deletion_submitted_at, ?) ELSE deletion_submitted_at END,
                deletion_finalized_at = ?, deletion_last_error = ?, delete_error = ?
          WHERE id = ? AND deletion_status IN ('pending', 'unconfirmed')
            AND deletion_next_attempt_at = ?`,
        input.result.status === 'submitted' ? 'unconfirmed' : finalAttempt ? 'failed' : 'pending',
        attempt,
        nextAttemptAt,
        input.result.status === 'submitted' ? 'unconfirmed' : 'pending',
        input.attemptedAt,
        finalAttempt ? input.attemptedAt : null,
        reason,
        reason,
        input.artifactId,
        input.claimExpiresAt
      );
    }
    const updated = db.get<EventAnnouncementMessageRow>(
      `SELECT * FROM event_announcement_messages WHERE id = ?`,
      input.artifactId
    );
    return updated ? eventAnnouncementMessageFromRow(updated) : undefined;
  });
}

export function confirmEventAnnouncementMessageDeleted(
  db: PluginDatabase,
  targetMessageId: string,
  confirmedAt: string
): StoredEventAnnouncementMessage[] {
  const matches = db.all<EventAnnouncementMessageRow>(
    `SELECT * FROM event_announcement_messages
      WHERE deleted_at IS NULL`
  ).filter((row) => equivalentWhatsAppMessageIds(row.message_id, targetMessageId));
  for (const row of matches) {
    db.run(
      `UPDATE event_announcement_messages
          SET deletion_status = CASE WHEN deletion_status IS NULL THEN NULL ELSE 'confirmed' END,
              deletion_next_attempt_at = NULL,
              deletion_confirmed_at = CASE WHEN deletion_status IS NULL THEN deletion_confirmed_at ELSE ? END,
              deletion_finalized_at = CASE WHEN deletion_status IS NULL THEN deletion_finalized_at ELSE ? END,
              deletion_last_error = NULL,
              deleted_at = ?, delete_error = NULL
        WHERE id = ? AND deleted_at IS NULL`,
      confirmedAt,
      confirmedAt,
      confirmedAt,
      row.id
    );
  }
  return matches.map((row) => ({
    ...eventAnnouncementMessageFromRow(row),
    ...(row.deletion_status ? {
      deletionStatus: 'confirmed' as const,
      deletionConfirmedAt: confirmedAt,
      deletionFinalizedAt: confirmedAt
    } : {}),
    deletedAt: confirmedAt
  }));
}

export function markEventAnnouncementMessageDeleted(
  db: PluginDatabase,
  id: string,
  deletedAt: string
): void {
  db.run(
      `UPDATE event_announcement_messages
        SET deleted_at = ?,
            delete_error = NULL,
            deletion_status = CASE WHEN deletion_status IS NULL THEN NULL ELSE 'confirmed' END,
            deletion_next_attempt_at = NULL,
            deletion_confirmed_at = CASE WHEN deletion_status IS NULL THEN deletion_confirmed_at ELSE ? END,
            deletion_finalized_at = CASE WHEN deletion_status IS NULL THEN deletion_finalized_at ELSE ? END,
            deletion_last_error = NULL
      WHERE id = ?`,
    deletedAt,
    deletedAt,
    deletedAt,
    id
  );
}

export function markEventAnnouncementMessageDeleteFailed(
  db: PluginDatabase,
  id: string,
  reason: string
): void {
  db.run(
      `UPDATE event_announcement_messages
        SET delete_error = ?
      WHERE id = ? AND deleted_at IS NULL`,
    reason,
    id
  );
}

export function markUnclaimedEventFailed(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  expectedUpdatedAt: string;
  expectedPollGeneration: number;
  expectedPollWaMsgId: string;
  reason: string;
  failedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'failed',
            group_lifecycle_status = 'none',
            calendar_status = 'hidden',
            error = ?,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'active'
        AND group_lifecycle_status = 'poll_open'
        AND updated_at = ?
        AND poll_generation = ?
        AND poll_wa_msg_id = ?
        AND provisioning_recovery_generation IS NULL
        AND provisioning_recovery_attempt IS NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM event_poll_replacements
           WHERE event_poll_replacements.event_id = event_records.id
             AND event_poll_replacements.status NOT IN ('completed', 'aborted')
        )`,
    input.reason,
    input.failedAt,
    input.eventId,
    input.scopeId,
    input.expectedUpdatedAt,
    input.expectedPollGeneration,
    input.expectedPollWaMsgId
  );
  return result.changes === 1;
}

export function claimInitialEventPreCreateProvisioningAttempt(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  expectedUpdatedAt: string;
  generation: string;
  attempt: number;
  claimedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_generation = ?,
            provisioning_recovery_attempt = ?,
            provisioning_recovery_next_run_at = NULL,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND subgroup_chat_id IS NULL
        AND actor_identity_id IS NOT NULL
        AND trim(actor_identity_id) <> ''
        AND updated_at = ?
        AND cleanup_at > ?
        AND provisioning_recovery_generation IS NULL
        AND provisioning_recovery_attempt IS NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM event_poll_replacements
           WHERE event_poll_replacements.event_id = event_records.id
             AND event_poll_replacements.status NOT IN ('completed', 'aborted')
        )
        AND (
          (origin IN ('created', 'adopted_poll')
            AND event_status = 'active'
            AND group_lifecycle_status = 'poll_open'
            AND poll_wa_msg_id IS NOT NULL)
          OR
          (origin = 'unplanned'
            AND event_status = 'failed'
            AND group_lifecycle_status = 'none'
            AND calendar_status IN ('hidden', 'included')
            AND poll_wa_msg_id IS NULL)
        )`,
    input.generation,
    input.attempt,
    input.claimedAt,
    input.eventId,
    input.scopeId,
    input.expectedUpdatedAt,
    input.claimedAt
  );
  return result.changes === 1;
}

export function claimInitialBoundPlannedEventProvisioningAttempt(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  expectedUpdatedAt: string;
  generation: string;
  attempt: number;
  claimedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_generation = ?,
            provisioning_recovery_attempt = ?,
            provisioning_recovery_next_run_at = NULL,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND origin IN ('created', 'adopted_poll')
        AND event_status = 'active'
        AND group_lifecycle_status = 'poll_open'
        AND poll_wa_msg_id IS NOT NULL
        AND subgroup_chat_id = ?
        AND actor_identity_id IS NOT NULL
        AND trim(actor_identity_id) <> ''
        AND updated_at = ?
        AND cleanup_at > ?
        AND provisioning_recovery_generation IS NULL
        AND provisioning_recovery_attempt IS NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND provisioning_recovery_halted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM event_poll_replacements
           WHERE event_poll_replacements.event_id = event_records.id
             AND event_poll_replacements.status NOT IN ('completed', 'aborted')
        )`,
    input.generation,
    input.attempt,
    input.claimedAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId,
    input.expectedUpdatedAt,
    input.claimedAt
  );
  return result.changes === 1;
}

export function haltInterruptedEventPreCreateClaimAtStartup(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  expectedUpdatedAt: string;
  generation: string;
  expectedAttempt: number;
  reason: string;
  failedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'failed',
            group_lifecycle_status = 'none',
            error = ?,
            provisioning_recovery_halted_at = ?,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND subgroup_chat_id IS NULL
        AND updated_at = ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND (
          (origin IN ('created', 'adopted_poll')
            AND event_status = 'active'
            AND group_lifecycle_status = 'poll_open'
            AND poll_wa_msg_id IS NOT NULL)
          OR
          (event_status = 'failed'
            AND group_lifecycle_status = 'none'
            AND calendar_status IN ('hidden', 'included')
            AND (
              (origin IN ('created', 'adopted_poll') AND poll_wa_msg_id IS NOT NULL)
              OR (origin = 'unplanned' AND poll_wa_msg_id IS NULL)
            ))
        )`,
    input.reason,
    input.failedAt,
    input.failedAt,
    input.eventId,
    input.scopeId,
    input.expectedUpdatedAt,
    input.generation,
    input.expectedAttempt
  );
  return result.changes === 1;
}

export function claimScheduledEventPreCreateProvisioningAttempt(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  generation: string;
  attempt: number;
  expectedNextRunAt: string;
  claimedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_next_run_at = NULL,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status = 'none'
        AND calendar_status IN ('hidden', 'included')
        AND subgroup_chat_id IS NULL
        AND cleanup_at > ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_next_run_at = ?`,
    input.claimedAt,
    input.eventId,
    input.scopeId,
    input.claimedAt,
    input.generation,
    input.attempt,
    input.expectedNextRunAt
  );
  return result.changes === 1;
}

export function rearmClaimedEventPreCreateProvisioningAttempt(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  generation: string;
  expectedAttempt: number;
  nextAttempt: number;
  nextRunAt: string;
  reason: string;
  rearmedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'failed',
            group_lifecycle_status = 'none',
            error = ?,
            provisioning_recovery_attempt = ?,
            provisioning_recovery_next_run_at = ?,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND subgroup_chat_id IS NULL
        AND cleanup_at > ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND (
          (origin IN ('created', 'adopted_poll')
            AND event_status IN ('active', 'failed')
            AND group_lifecycle_status IN ('poll_open', 'none')
            AND poll_wa_msg_id IS NOT NULL)
          OR
          (origin = 'unplanned'
            AND event_status = 'failed'
            AND group_lifecycle_status = 'none'
            AND poll_wa_msg_id IS NULL)
        )`,
    input.reason,
    input.nextAttempt,
    input.nextRunAt,
    input.rearmedAt,
    input.eventId,
    input.scopeId,
    input.nextRunAt,
    input.generation,
    input.expectedAttempt
  );
  return result.changes === 1;
}

export function checkpointClaimedEventProvisioningChild(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  generation: string;
  expectedAttempt: number;
  nextAttempt: number;
  nextRunAt?: string | undefined;
  subgroupChatId: string;
  subgroupTitle: string;
  participants: Record<string, CreatedGroupParticipantResult>;
  creator?: EventCreatorParticipantPrincipal | undefined;
  checkpointedAt: string;
  haltedAt?: string | undefined;
  reason?: string | undefined;
}): boolean {
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id
         FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND subgroup_chat_id IS NULL
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND provisioning_recovery_next_run_at IS NULL
          AND (
            (origin IN ('created', 'adopted_poll')
              AND event_status IN ('active', 'failed')
              AND group_lifecycle_status IN ('poll_open', 'none'))
            OR
            (origin = 'unplanned'
              AND event_status = 'failed'
              AND group_lifecycle_status = 'none')
          )`,
      input.eventId,
      input.scopeId,
      input.generation,
      input.expectedAttempt
    );
    if (!current) {
      return false;
    }
    db.run('DELETE FROM event_group_participants WHERE event_id = ?', input.eventId);
    writeCreatedGroupParticipants(db, input.eventId, input.participants, input.checkpointedAt, input.creator);
    const result = db.run(
      `UPDATE event_records
          SET event_status = 'failed',
              group_lifecycle_status = 'none',
              subgroup_chat_id = ?,
              subgroup_title = ?,
              error = ?,
              provisioning_recovery_attempt = ?,
              provisioning_recovery_next_run_at = ?,
              provisioning_recovery_halted_at = ?,
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND subgroup_chat_id IS NULL
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND provisioning_recovery_next_run_at IS NULL`,
      input.subgroupChatId,
      input.subgroupTitle,
      input.reason ?? null,
      input.nextAttempt,
      input.nextRunAt ?? null,
      input.haltedAt ?? null,
      input.checkpointedAt,
      input.eventId,
      input.scopeId,
      input.generation,
      input.expectedAttempt
    );
    if (result.changes !== 1) {
      throw new Error(`Event ${input.eventId} changed while binding its claimed subgroup.`);
    }
    return true;
  });
}

export function bindClaimedInitialPlannedEventProvisioningChild(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  generation: string;
  expectedAttempt: number;
  subgroupChatId: string;
  subgroupTitle: string;
  participants: Record<string, CreatedGroupParticipantResult>;
  creator?: EventCreatorParticipantPrincipal | undefined;
  boundAt: string;
}): boolean {
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id
         FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND origin IN ('created', 'adopted_poll')
          AND event_status = 'active'
          AND group_lifecycle_status = 'poll_open'
          AND subgroup_chat_id IS NULL
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_next_run_at IS NULL`,
      input.eventId,
      input.scopeId,
      input.generation,
      input.expectedAttempt
    );
    if (!current) {
      return false;
    }
    db.run('DELETE FROM event_group_participants WHERE event_id = ?', input.eventId);
    writeCreatedGroupParticipants(db, input.eventId, input.participants, input.boundAt, input.creator);
    const result = db.run(
      `UPDATE event_records
          SET subgroup_chat_id = ?,
              subgroup_title = ?,
              error = NULL,
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND origin IN ('created', 'adopted_poll')
          AND event_status = 'active'
          AND group_lifecycle_status = 'poll_open'
          AND subgroup_chat_id IS NULL
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_next_run_at IS NULL`,
      input.subgroupChatId,
      input.subgroupTitle,
      input.boundAt,
      input.eventId,
      input.scopeId,
      input.generation,
      input.expectedAttempt
    );
    if (result.changes !== 1) {
      throw new Error(`Event ${input.eventId} changed while binding its initial planned subgroup.`);
    }
    return true;
  });
}

/**
 * Moves an exact, durably bound planned-event candidate out of the close path
 * and into known-child recovery. This is the failure fence for required child
 * configuration: a persistent configuration error must not be retried by the
 * one-second poll-close loop, and a stale close worker must not be able to
 * overwrite an operator halt or a newer recovery attempt.
 */
export function failClaimedBoundPlannedEventProvisioningChild(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  participants: Record<string, CreatedGroupParticipantResult>;
  creator?: EventCreatorParticipantPrincipal | undefined;
  generation: string;
  expectedAttempt: number;
  nextAttempt: number;
  nextRunAt?: string | undefined;
  haltedAt?: string | undefined;
  reason: string;
  failedAt: string;
}): boolean {
  if (Boolean(input.nextRunAt) === Boolean(input.haltedAt)) {
    throw new Error(
      'A bound event provisioning failure must be either scheduled or halted.'
    );
  }
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id
         FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND origin IN ('created', 'adopted_poll')
          AND event_status = 'active'
          AND group_lifecycle_status = 'poll_open'
          AND subgroup_chat_id = ?
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND provisioning_recovery_next_run_at IS NULL`,
      input.eventId,
      input.scopeId,
      input.subgroupChatId,
      input.generation,
      input.expectedAttempt
    );
    if (!current) {
      return false;
    }
    db.run('DELETE FROM event_group_participants WHERE event_id = ?', input.eventId);
    writeCreatedGroupParticipants(db, input.eventId, input.participants, input.failedAt, input.creator);
    const result = db.run(
      `UPDATE event_records
          SET event_status = 'failed',
              group_lifecycle_status = 'none',
              calendar_status = 'hidden',
              subgroup_title = ?,
              error = ?,
              provisioning_recovery_attempt = ?,
              provisioning_recovery_next_run_at = ?,
              provisioning_recovery_halted_at = ?,
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND origin IN ('created', 'adopted_poll')
          AND event_status = 'active'
          AND group_lifecycle_status = 'poll_open'
          AND subgroup_chat_id = ?
          AND provisioning_recovery_generation = ?
          AND provisioning_recovery_attempt = ?
          AND provisioning_recovery_halted_at IS NULL
          AND provisioning_recovery_next_run_at IS NULL`,
      input.subgroupTitle,
      input.reason,
      input.nextAttempt,
      input.nextRunAt ?? null,
      input.haltedAt ?? null,
      input.failedAt,
      input.eventId,
      input.scopeId,
      input.subgroupChatId,
      input.generation,
      input.expectedAttempt
    );
    if (result.changes !== 1) {
      throw new Error(
        `Event ${input.eventId} changed while fencing its bound subgroup failure.`
      );
    }
    return true;
  });
}

export function haltClaimedEventPreCreateProvisioning(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  generation: string;
  expectedAttempt: number;
  reason: string;
  haltedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'failed',
            group_lifecycle_status = 'none',
            error = ?,
            provisioning_recovery_halted_at = ?,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND subgroup_chat_id IS NULL
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND event_status IN ('active', 'failed')
        AND group_lifecycle_status IN ('poll_open', 'none')`,
    input.reason,
    input.haltedAt,
    input.haltedAt,
    input.eventId,
    input.scopeId,
    input.generation,
    input.expectedAttempt
  );
  return result.changes === 1;
}

export function markClaimedEventPreCreateProvisioningMissed(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  generation: string;
  expectedAttempt: number;
  expectedCleanupAt: string;
  reason: string;
  missedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'failed',
            group_lifecycle_status = 'missed',
            error = ?,
            provisioning_recovery_generation = NULL,
            provisioning_recovery_attempt = NULL,
            provisioning_recovery_next_run_at = NULL,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND subgroup_chat_id IS NULL
        AND cleanup_at = ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND event_status IN ('active', 'failed')
        AND group_lifecycle_status IN ('poll_open', 'none')`,
    input.reason,
    input.missedAt,
    input.eventId,
    input.scopeId,
    input.expectedCleanupAt,
    input.generation,
    input.expectedAttempt
  );
  return result.changes === 1;
}

export function markScheduledEventPreCreateProvisioningMissed(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  generation: string;
  expectedAttempt: number;
  expectedNextRunAt: string;
  expectedCleanupAt: string;
  reason: string;
  missedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'failed',
            group_lifecycle_status = 'missed',
            error = ?,
            provisioning_recovery_generation = NULL,
            provisioning_recovery_attempt = NULL,
            provisioning_recovery_next_run_at = NULL,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status = 'none'
        AND subgroup_chat_id IS NULL
        AND cleanup_at = ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND provisioning_recovery_next_run_at = ?`,
    input.reason,
    input.missedAt,
    input.eventId,
    input.scopeId,
    input.expectedCleanupAt,
    input.generation,
    input.expectedAttempt,
    input.expectedNextRunAt
  );
  return result.changes === 1;
}

export function initializeEventProvisioningRecovery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  generation: string;
  attempt: number;
  nextRunAt: string;
  updatedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_generation = ?,
            provisioning_recovery_attempt = ?,
            provisioning_recovery_next_run_at = ?,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status IN ('none', 'poll_closed')
        AND subgroup_chat_id = ?
        AND provisioning_recovery_generation IS NULL
        AND provisioning_recovery_attempt IS NULL
        AND provisioning_recovery_next_run_at IS NULL`,
    input.generation,
    input.attempt,
    input.nextRunAt,
    input.updatedAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId
  );
  return result.changes === 1;
}

/**
 * Transfers one exact known-child provisioning cursor to cleanup ownership.
 *
 * The cursor and event revision are part of the compare-and-swap so a cleanup
 * worker can never overtake a newer recovery attempt. Clearing every recovery
 * field is the terminal fence: stale recovery deliveries can no longer claim,
 * checkpoint, configure, link, or advance this child.
 */
export function expireKnownChildEventProvisioningForCleanup(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  expectedUpdatedAt: string;
  expectedCleanupAt: string;
  generation: string;
  attempt: number;
  expectedNextRunAt: string | null;
  expectedHaltedAt: string | null;
  reason: string;
  expiredAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'failed',
            group_lifecycle_status = 'cleanup_failed',
            error = ?,
            provisioning_recovery_generation = NULL,
            provisioning_recovery_attempt = NULL,
            provisioning_recovery_next_run_at = NULL,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status IN ('none', 'poll_closed')
        AND subgroup_chat_id = ?
        AND cleanup_at = ?
        AND cleanup_at <= ?
        AND updated_at = ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND ((? IS NULL AND provisioning_recovery_next_run_at IS NULL)
          OR provisioning_recovery_next_run_at = ?)
        AND ((? IS NULL AND provisioning_recovery_halted_at IS NULL)
          OR provisioning_recovery_halted_at = ?)
        AND NOT EXISTS (
          SELECT 1
            FROM event_cleanup_claims
           WHERE event_cleanup_claims.event_id = event_records.id
        )`,
    input.reason,
    input.expiredAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId,
    input.expectedCleanupAt,
    input.expiredAt,
    input.expectedUpdatedAt,
    input.generation,
    input.attempt,
    input.expectedNextRunAt,
    input.expectedNextRunAt,
    input.expectedHaltedAt,
    input.expectedHaltedAt
  );
  return result.changes === 1;
}

export function renewClaimedEventCommunityLinkLease(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  expectedUpdatedAt: string;
  generation: string;
  attempt: number;
  renewedAt: string;
}): boolean {
  const expectedTime = new Date(input.expectedUpdatedAt).getTime();
  const renewedTime = new Date(input.renewedAt).getTime();
  if (
    !Number.isFinite(expectedTime) ||
    !Number.isFinite(renewedTime) ||
    renewedTime <= expectedTime
  ) {
    return false;
  }
  return db.run(
    `UPDATE event_records
        SET updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status = 'poll_closed'
        AND calendar_status = 'included'
        AND subgroup_chat_id = ?
        AND cleanup_at > ?
        AND updated_at = ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND provisioning_recovery_next_run_at IS NULL`,
    input.renewedAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId,
    input.renewedAt,
    input.expectedUpdatedAt,
    input.generation,
    input.attempt
  ).changes === 1;
}

/**
 * Renews one exact claimed known-child provisioning lease before entering a
 * provider operation. The event state is part of the compare-and-swap so a
 * stale worker cannot cross a cleanup transfer, a newer recovery claim, or a
 * lifecycle transition and then mutate the preserved child.
 */
export function renewClaimedKnownChildEventProvisioningLease(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  expectedEventStatus: EventStatus;
  expectedGroupLifecycleStatus: EventGroupLifecycleStatus;
  expectedUpdatedAt: string;
  generation: string;
  attempt: number;
  renewedAt: string;
}): boolean {
  const validState = (
    input.expectedEventStatus === 'active' &&
    input.expectedGroupLifecycleStatus === 'poll_open'
  ) || (
    input.expectedEventStatus === 'failed' &&
    (input.expectedGroupLifecycleStatus === 'none' ||
      input.expectedGroupLifecycleStatus === 'poll_closed')
  );
  const expectedTime = new Date(input.expectedUpdatedAt).getTime();
  const renewedTime = new Date(input.renewedAt).getTime();
  if (
    !validState ||
    !Number.isFinite(expectedTime) ||
    !Number.isFinite(renewedTime) ||
    renewedTime <= expectedTime
  ) {
    return false;
  }
  return db.run(
    `UPDATE event_records
        SET updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = ?
        AND group_lifecycle_status = ?
        AND subgroup_chat_id = ?
        AND cleanup_at > ?
        AND updated_at = ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND provisioning_recovery_next_run_at IS NULL`,
    input.renewedAt,
    input.eventId,
    input.scopeId,
    input.expectedEventStatus,
    input.expectedGroupLifecycleStatus,
    input.subgroupChatId,
    input.renewedAt,
    input.expectedUpdatedAt,
    input.generation,
    input.attempt
  ).changes === 1;
}

export function nextEventRevisionTimestamp(expectedUpdatedAt: string, now: Date = new Date()): string {
  const expectedTime = new Date(expectedUpdatedAt).getTime();
  const nowTime = now.getTime();
  if (!Number.isFinite(expectedTime) || !Number.isFinite(nowTime)) {
    throw new Error(`Cannot advance invalid event revision ${expectedUpdatedAt}.`);
  }
  return new Date(Math.max(nowTime, expectedTime + 1)).toISOString();
}

/**
 * Claims one exact, scheduled known-child recovery delivery before any
 * provider operation runs. A crash after this fence leaves an explicit claimed
 * cursor that startup recovery may redeliver through the transport's durable
 * mutation ledger.
 */
export function claimScheduledKnownChildEventProvisioningAttempt(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  generation: string;
  attempt: number;
  expectedNextRunAt: string;
  claimedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_next_run_at = NULL,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status IN ('none', 'poll_closed')
        AND subgroup_chat_id = ?
        AND cleanup_at > ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND provisioning_recovery_next_run_at = ?`,
    input.claimedAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId,
    input.claimedAt,
    input.generation,
    input.attempt,
    input.expectedNextRunAt
  );
  return result.changes === 1;
}

/**
 * Re-arms an exact known-child cursor that was left claimed when the process
 * stopped. The transport's durable mutation ledger remains authoritative, so
 * this only restores delivery of a reconciliation readback after restart.
 */
export function rearmClaimedKnownChildEventProvisioningForStartup(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  generation: string;
  attempt: number;
  nextRunAt: string;
  rearmedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_next_run_at = ?,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status IN ('none', 'poll_closed')
        AND subgroup_chat_id = ?
        AND cleanup_at > ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND provisioning_recovery_next_run_at IS NULL`,
    input.nextRunAt,
    input.rearmedAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId,
    input.rearmedAt,
    input.generation,
    input.attempt
  );
  return result.changes === 1;
}

export function haltClaimedKnownChildEventProvisioning(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  generation: string;
  expectedAttempt: number;
  reason: string;
  haltedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET error = ?,
            provisioning_recovery_halted_at = ?,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status IN ('none', 'poll_closed')
        AND subgroup_chat_id = ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND provisioning_recovery_next_run_at IS NULL`,
    input.reason,
    input.haltedAt,
    input.haltedAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId,
    input.generation,
    input.expectedAttempt
  );
  return result.changes === 1;
}

export function initializeEventPreCreateProvisioningRecovery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  expectedUpdatedAt: string;
  generation: string;
  attempt: number;
  nextRunAt: string;
  updatedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_generation = ?,
            provisioning_recovery_attempt = ?,
            provisioning_recovery_next_run_at = ?,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status = 'none'
        AND calendar_status IN ('hidden', 'included')
        AND subgroup_chat_id IS NULL
        AND actor_identity_id IS NOT NULL
        AND trim(actor_identity_id) <> ''
        AND (
          (origin IN ('created', 'adopted_poll') AND poll_wa_msg_id IS NOT NULL)
          OR (origin = 'unplanned' AND poll_wa_msg_id IS NULL)
        )
        AND cleanup_at > ?
        AND updated_at = ?
        AND provisioning_recovery_generation IS NULL
        AND provisioning_recovery_attempt IS NULL
        AND provisioning_recovery_next_run_at IS NULL`,
    input.generation,
    input.attempt,
    input.nextRunAt,
    input.updatedAt,
    input.eventId,
    input.scopeId,
    input.nextRunAt,
    input.expectedUpdatedAt
  );
  return result.changes === 1;
}

export function resetHaltedEventPreCreateProvisioningRecovery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  expectedUpdatedAt: string;
  generation: string;
  attempt: number;
  nextRunAt: string;
  updatedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_generation = ?,
            provisioning_recovery_attempt = ?,
            provisioning_recovery_next_run_at = ?,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status = 'none'
        AND calendar_status IN ('hidden', 'included')
        AND subgroup_chat_id IS NULL
        AND actor_identity_id IS NOT NULL
        AND trim(actor_identity_id) <> ''
        AND (
          (origin IN ('created', 'adopted_poll') AND poll_wa_msg_id IS NOT NULL)
          OR (origin = 'unplanned' AND poll_wa_msg_id IS NULL)
        )
        AND cleanup_at > ?
        AND updated_at = ?
        AND provisioning_recovery_generation IS NOT NULL
        AND provisioning_recovery_attempt IS NOT NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND provisioning_recovery_halted_at IS NOT NULL`,
    input.generation,
    input.attempt,
    input.nextRunAt,
    input.updatedAt,
    input.eventId,
    input.scopeId,
    input.nextRunAt,
    input.expectedUpdatedAt
  );
  return result.changes === 1;
}

export function advanceEventProvisioningRecovery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId?: string | undefined;
  generation: string;
  expectedAttempt: number;
  expectedNextRunAt: string | null;
  nextAttempt: number;
  nextRunAt: string;
  updatedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_attempt = ?,
            provisioning_recovery_next_run_at = ?,
            provisioning_recovery_halted_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND cleanup_at > ?
        AND (
          (? IS NULL AND group_lifecycle_status = 'none' AND subgroup_chat_id IS NULL)
          OR (? IS NOT NULL AND group_lifecycle_status IN ('none', 'poll_closed') AND subgroup_chat_id = ?)
        )
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?
        AND provisioning_recovery_halted_at IS NULL
        AND ((? IS NULL AND provisioning_recovery_next_run_at IS NULL)
          OR provisioning_recovery_next_run_at = ?)`,
    input.nextAttempt,
    input.nextRunAt,
    input.updatedAt,
    input.eventId,
    input.scopeId,
    input.updatedAt,
    input.subgroupChatId ?? null,
    input.subgroupChatId ?? null,
    input.subgroupChatId ?? null,
    input.generation,
    input.expectedAttempt,
    input.expectedNextRunAt,
    input.expectedNextRunAt
  );
  return result.changes === 1;
}

export function markUnclaimedEventPreCreateProvisioningMissed(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  expectedUpdatedAt: string;
  expectedCleanupAt: string;
  reason: string;
  missedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'failed',
            group_lifecycle_status = 'missed',
            calendar_status = 'hidden',
            error = ?,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'active'
        AND group_lifecycle_status = 'poll_open'
        AND subgroup_chat_id IS NULL
        AND updated_at = ?
        AND cleanup_at = ?
        AND provisioning_recovery_generation IS NULL
        AND provisioning_recovery_attempt IS NULL
        AND provisioning_recovery_next_run_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM event_poll_replacements
           WHERE event_poll_replacements.event_id = event_records.id
             AND event_poll_replacements.status NOT IN ('completed', 'aborted')
        )`,
    input.reason,
    input.missedAt,
    input.eventId,
    input.scopeId,
    input.expectedUpdatedAt,
    input.expectedCleanupAt
  );
  return result.changes === 1;
}

export function upsertVote(db: PluginDatabase, eventId: string, vote: PluginPollVote): void {
  const voterIdentityId = vote.voterIdentityId.trim();
  const voterWid = vote.voterWid.trim();
  if (!voterIdentityId || !voterWid) {
    throw new Error('Event votes require an authoritative voter identity and delivery address.');
  }
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO event_votes (
       event_id, voter_identity_id, voter_wid, selected_option_ids_json, selected_option_names_json,
       selected_option_numbers_json, interacted_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, voter_identity_id) DO UPDATE SET
       voter_wid = excluded.voter_wid,
       selected_option_ids_json = excluded.selected_option_ids_json,
       selected_option_names_json = excluded.selected_option_names_json,
       selected_option_numbers_json = excluded.selected_option_numbers_json,
       interacted_at = excluded.interacted_at,
       updated_at = excluded.updated_at`,
    eventId,
    voterIdentityId,
    voterWid,
    JSON.stringify(vote.selectedOptionIds),
    JSON.stringify(vote.selectedOptionNames),
    JSON.stringify(vote.selectedOptionNumbers),
    vote.interactedAt?.toISOString() ?? null,
    now
  );
}

export function upsertVoteForOpenPollGeneration(db: PluginDatabase, input: {
  eventId: string;
  pollWaMsgId: string;
  pollGeneration: number;
  vote: PluginPollVote;
}): boolean {
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id FROM event_records
        WHERE id = ?
          AND event_status = 'active'
          AND group_lifecycle_status = 'poll_open'
          AND poll_wa_msg_id = ?
          AND poll_generation = ?
          AND NOT EXISTS (
            SELECT 1 FROM event_poll_replacements
             WHERE event_poll_replacements.event_id = event_records.id
               AND event_poll_replacements.status NOT IN ('completed', 'aborted')
          )`,
      input.eventId,
      input.pollWaMsgId,
      input.pollGeneration
    );
    if (!current) {
      return false;
    }
    upsertVote(db, input.eventId, input.vote);
    return true;
  });
}

export function replaceVotes(db: PluginDatabase, eventId: string, votes: PluginPollVote[]): void {
  db.transaction(() => {
    db.run('DELETE FROM event_votes WHERE event_id = ?', eventId);
    for (const vote of votes) {
      upsertVote(db, eventId, vote);
    }
  });
}

export function replaceVotesForOpenPollGeneration(db: PluginDatabase, input: {
  eventId: string;
  pollWaMsgId: string;
  pollGeneration: number;
  votes: PluginPollVote[];
}): boolean {
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id FROM event_records
        WHERE id = ?
          AND event_status = 'active'
          AND group_lifecycle_status = 'poll_open'
          AND poll_wa_msg_id = ?
          AND poll_generation = ?
          AND NOT EXISTS (
            SELECT 1 FROM event_poll_replacements
             WHERE event_poll_replacements.event_id = event_records.id
               AND event_poll_replacements.status NOT IN ('completed', 'aborted')
          )`,
      input.eventId,
      input.pollWaMsgId,
      input.pollGeneration
    );
    if (!current) {
      return false;
    }
    db.run('DELETE FROM event_votes WHERE event_id = ?', input.eventId);
    for (const vote of input.votes) {
      upsertVote(db, input.eventId, vote);
    }
    return true;
  });
}

export function listVotes(db: PluginDatabase, eventId: string): StoredEventVote[] {
  return db.all<VoteRow>(
    'SELECT * FROM event_votes WHERE event_id = ? ORDER BY voter_identity_id ASC',
    eventId
  ).map(voteFromRow);
}

export function listCreatedGroupParticipants(
  db: PluginDatabase,
  eventId: string
): StoredCreatedGroupParticipant[] {
  return db.all<{
    event_id: string;
    wid: string;
    identity_id: string | null;
    evidence_digest: string | null;
    status_code: number | null;
    message: string | null;
    is_group_creator: number;
    is_invite_v4_sent: number;
    required_creator_membership_status: string | null;
    created_at: string;
  }>(
    `SELECT event_id, wid, identity_id, evidence_digest, status_code, message, is_group_creator, is_invite_v4_sent,
            required_creator_membership_status, created_at
       FROM event_group_participants
      WHERE event_id = ?
      ORDER BY wid ASC`,
    eventId
  ).map((row) => {
    const creatorMembershipStatus = requiredCreatorMembershipStatus(
      row.required_creator_membership_status
    );
    return {
      eventId: row.event_id,
      wid: row.wid,
      ...(row.identity_id ? { identityId: row.identity_id } : {}),
      ...(row.evidence_digest ? { evidenceDigest: row.evidence_digest } : {}),
      ...(row.status_code !== null ? { statusCode: row.status_code } : {}),
      ...(row.message ? { message: row.message } : {}),
      isGroupCreator: row.is_group_creator === 1,
      isInviteV4Sent: row.is_invite_v4_sent === 1,
      ...(creatorMembershipStatus
        ? { requiredCreatorMembershipStatus: creatorMembershipStatus }
        : {}),
      createdAt: row.created_at
    };
  });
}

/**
 * Reads the required creator by its persisted platform principal. This never
 * infers PN/LID equivalence from participant keys; legacy rows are eligible
 * only after migration explicitly bound them to the event actor identity.
 */
export function getEventRequiredCreatorReference(
  db: PluginDatabase,
  eventId: string,
  actorIdentityId: string
): PersistedRequiredCreatorReference | undefined {
  const identityId = requiredTrimmedValue(actorIdentityId, 'event actor identity ID');
  const rows = db.all<{
    wid: string;
    identity_id: string;
    evidence_digest: string | null;
  }>(
    `SELECT wid, identity_id, evidence_digest
       FROM event_group_participants
      WHERE event_id = ?
        AND identity_id = ?
        AND required_creator_membership_status IS NOT NULL
      ORDER BY created_at DESC, wid ASC`,
    eventId,
    identityId
  );
  if (rows.length > 1) {
    throw new Error(
      `Event ${eventId} has multiple required creator outcomes for identity ${identityId}.`
    );
  }
  const row = rows[0];
  if (!row) {
    return undefined;
  }
  return {
    identityId: row.identity_id,
    participantWid: row.wid,
    ...(row.evidence_digest ? { evidenceDigest: row.evidence_digest } : {})
  };
}

export function saveCreatedGroupParticipants(
  db: PluginDatabase,
  eventId: string,
  participants: Record<string, CreatedGroupParticipantResult>,
  creator?: EventCreatorParticipantPrincipal | undefined
): void {
  db.transaction(() => {
    writeCreatedGroupParticipants(db, eventId, participants, new Date().toISOString(), creator);
  });
}

function writeCreatedGroupParticipants(
  db: PluginDatabase,
  eventId: string,
  participants: Record<string, CreatedGroupParticipantResult>,
  createdAt: string,
  creator?: EventCreatorParticipantPrincipal | undefined
): void {
  const creatorBinding = validatedCreatorParticipantBinding(participants, creator);
  if (creatorBinding) {
    const existing = db.get<{ identity_id: string | null }>(
      `SELECT identity_id
         FROM event_group_participants
        WHERE event_id = ? AND wid = ?`,
      eventId,
      creatorBinding.participantWid
    );
    if (existing?.identity_id && existing.identity_id !== creatorBinding.identityId) {
      throw new Error(
        `Participant ${creatorBinding.participantWid} is already bound to conflicting identity ${existing.identity_id}.`
      );
    }
    db.run(
      `DELETE FROM event_group_participants
        WHERE event_id = ?
          AND identity_id = ?
          AND wid <> ?`,
      eventId,
      creatorBinding.identityId,
      creatorBinding.participantWid
    );
  }
  const insert = db.prepare(
    `INSERT INTO event_group_participants (
       event_id, wid, identity_id, evidence_digest, status_code, message, is_group_creator, is_invite_v4_sent,
       required_creator_membership_status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, wid) DO UPDATE SET
       identity_id = COALESCE(
         excluded.identity_id,
         event_group_participants.identity_id
       ),
       evidence_digest = COALESCE(
         excluded.evidence_digest,
         event_group_participants.evidence_digest
       ),
       status_code = excluded.status_code,
       message = excluded.message,
       is_group_creator = excluded.is_group_creator,
       is_invite_v4_sent = excluded.is_invite_v4_sent,
       required_creator_membership_status = COALESCE(
         excluded.required_creator_membership_status,
         event_group_participants.required_creator_membership_status
       )`
  );
  for (const [wid, participant] of Object.entries(participants)) {
    const normalizedWid = requiredTrimmedValue(wid, 'participant WID');
    const isCreator = creatorBinding?.participantWid === normalizedWid;
    insert.run(
      eventId,
      normalizedWid,
      isCreator ? creatorBinding.identityId : null,
      isCreator ? creatorBinding.evidenceDigest ?? null : null,
      participant.statusCode ?? null,
      participant.message ?? null,
      participant.isGroupCreator ? 1 : 0,
      participant.isInviteV4Sent ? 1 : 0,
      participant.requiredCreatorMembershipStatus ?? null,
      createdAt
    );
  }
}

function validatedCreatorParticipantBinding(
  participants: Record<string, CreatedGroupParticipantResult>,
  creator: EventCreatorParticipantPrincipal | undefined
): EventCreatorParticipantPrincipal | undefined {
  const creatorOutcomes = Object.entries(participants).filter(([, participant]) =>
    participant.requiredCreatorMembershipStatus !== undefined);
  if (creatorOutcomes.length === 0) {
    if (creator) {
      throw new Error('A creator participant principal requires one explicit creator membership outcome.');
    }
    return undefined;
  }
  if (!creator) {
    throw new Error('A required creator membership outcome requires an explicit creator identity principal.');
  }
  if (creatorOutcomes.length !== 1) {
    throw new Error('An event may persist exactly one required creator membership outcome.');
  }
  const identityId = requiredTrimmedValue(creator.identityId, 'creatorIdentityId');
  const participantWid = requiredTrimmedValue(creator.participantWid, 'creatorParticipantWid');
  const evidenceDigest = creator.evidenceDigest === undefined
    ? undefined
    : requiredEvidenceDigest(creator.evidenceDigest);
  const [outcomeWid] = creatorOutcomes[0]!;
  if (requiredTrimmedValue(outcomeWid, 'creator outcome WID') !== participantWid) {
    throw new Error(
      `Creator participant ${participantWid} does not match the explicit creator outcome ${outcomeWid}.`
    );
  }
  return {
    identityId,
    participantWid,
    ...(evidenceDigest ? { evidenceDigest } : {})
  };
}

function requiredEvidenceDigest(value: string): string {
  const normalized = requiredTrimmedValue(value, 'creatorEvidenceDigest').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('creatorEvidenceDigest must be a SHA-256 digest.');
  }
  return normalized;
}

function requiredTrimmedValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function requiredCreatorMembershipStatus(
  value: string | null
): CreatedGroupParticipantResult['requiredCreatorMembershipStatus'] {
  switch (value) {
    case 'initial_create_missing':
    case 'technical_retry_pending':
    case 'direct_add_pending':
    case 'invite_pending':
    case 'privacy_invite_delivery_uncertain':
    case 'privacy_action_required':
    case 'provider_rejection':
    case 'outcome_ambiguous':
    case 'direct_add_not_observed':
    case 'membership_confirmed':
      return value;
    case null:
      return undefined;
    default:
      throw new Error(`Invalid persisted required creator membership status: ${value}`);
  }
}

export function appendEventLog(db: PluginDatabase, input: {
  eventId?: string | undefined;
  action: string;
  metadata?: unknown;
}): void {
  db.run(
    'INSERT INTO event_logs (id, event_id, action, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)',
    randomUUID(),
    input.eventId ?? null,
    input.action,
    JSON.stringify(input.metadata ?? {}),
    new Date().toISOString()
  );
}

export function getEventWeatherDelivery(
  db: PluginDatabase,
  eventId: string,
  kind: string,
  eventUpdatedAt: string
): StoredEventWeatherDelivery | undefined {
  const row = db.get<EventWeatherDeliveryRow>(
    `SELECT * FROM event_weather_deliveries
      WHERE event_id = ? AND kind = ? AND event_updated_at = ?`,
    eventId,
    kind,
    eventUpdatedAt
  );
  return row ? eventWeatherDeliveryFromRow(row) : undefined;
}

export function hasSentEventWeatherDeliveryForKind(
  db: PluginDatabase,
  eventId: string,
  kind: string
): boolean {
  return Boolean(db.get<{ present: number }>(
    `SELECT 1 AS present
       FROM event_weather_deliveries
      WHERE event_id = ? AND kind = ? AND status = 'sent'
      LIMIT 1`,
    eventId,
    kind
  ));
}

export function listRecoverableEventWeatherDeliveries(
  db: PluginDatabase
): StoredEventWeatherDelivery[] {
  return db.all<EventWeatherDeliveryRow>(
    `SELECT *
       FROM event_weather_deliveries
      WHERE status IN ('pending', 'sending')
      ORDER BY COALESCE(next_run_at, lease_expires_at, scheduled_at) ASC, event_id ASC, kind ASC`
  ).map(eventWeatherDeliveryFromRow);
}

export function prepareEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  scheduleKind: EventWeatherDeliveryScheduleKind;
  scheduledAt: string;
  chatId: string;
  meteorologicalText?: string | undefined;
  marineText?: string | undefined;
  meteorologicalIdempotencyKey?: string | undefined;
  marineIdempotencyKey?: string | undefined;
  preparedAt?: string | undefined;
}): StoredEventWeatherDelivery {
  const meteorologicalText = input.meteorologicalText?.trim() || undefined;
  const marineText = input.marineText?.trim() || undefined;
  if (!meteorologicalText && !marineText) {
    throw new Error(`Cannot prepare empty weather delivery ${input.eventId}/${input.kind}.`);
  }
  if (meteorologicalText && !input.meteorologicalIdempotencyKey?.trim()) {
    throw new Error(`Weather delivery ${input.eventId}/${input.kind} has no meteorological idempotency key.`);
  }
  if (marineText && !input.marineIdempotencyKey?.trim()) {
    throw new Error(`Weather delivery ${input.eventId}/${input.kind} has no marine idempotency key.`);
  }
  return db.transaction(() => {
    if (!eventRecordVersionMatches(db, input.eventId, input.eventUpdatedAt)) {
      throw new Error(
        `Event ${input.eventId} changed before weather delivery ${input.kind} could be prepared.`
      );
    }
    const existing = getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
    if (existing?.status === 'sent' || existing?.status === 'skipped') {
      return existing;
    }
    if (
      existing?.chatId &&
      (existing.meteorologicalText || existing.marineText) &&
      (!existing.meteorologicalText || existing.meteorologicalIdempotencyKey) &&
      (!existing.marineText || existing.marineIdempotencyKey)
    ) {
      return existing;
    }
    const preparedAt = input.preparedAt ?? new Date().toISOString();
    const persisted = db.run(
      `INSERT INTO event_weather_deliveries (
         event_id, event_updated_at, kind, schedule_kind, scheduled_at, status, chat_id,
         meteorological_text, marine_text,
         meteorological_idempotency_key, marine_idempotency_key,
         meteorological_message_id, marine_message_id,
         claim_id, lease_expires_at, attempt, next_run_at,
         sent_at, skipped_at, error, updated_at
       )
       SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, NULL, NULL, NULL, ?
         FROM event_records
        WHERE id = ? AND updated_at = ?
       ON CONFLICT(event_id, kind, event_updated_at) DO UPDATE SET
         schedule_kind = excluded.schedule_kind,
         scheduled_at = excluded.scheduled_at,
         status = 'pending',
         chat_id = excluded.chat_id,
         meteorological_text = excluded.meteorological_text,
         marine_text = excluded.marine_text,
         meteorological_idempotency_key = excluded.meteorological_idempotency_key,
         marine_idempotency_key = excluded.marine_idempotency_key,
         claim_id = NULL,
         lease_expires_at = NULL,
         next_run_at = excluded.next_run_at,
         error = NULL,
         updated_at = excluded.updated_at
      WHERE event_weather_deliveries.status IN ('pending', 'sending')`,
      input.eventId,
      input.eventUpdatedAt,
      input.kind,
      input.scheduleKind,
      input.scheduledAt,
      input.chatId,
      meteorologicalText ?? null,
      marineText ?? null,
      input.meteorologicalIdempotencyKey?.trim() ?? null,
      input.marineIdempotencyKey?.trim() ?? null,
      preparedAt,
      preparedAt,
      input.eventId,
      input.eventUpdatedAt
    );
    if (persisted.changes !== 1) {
      throw new Error(
        `Event ${input.eventId} changed before weather delivery ${input.kind} could be prepared.`
      );
    }
    const prepared = getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
    if (!prepared) {
      throw new Error(`Could not read prepared weather delivery ${input.eventId}/${input.kind}.`);
    }
    return prepared;
  });
}

export function claimEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  claimedAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
}): ClaimedEventWeatherDelivery | undefined {
  return db.transaction(() => {
    const claimedAt = input.claimedAt ?? new Date().toISOString();
    const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
      new Date(claimedAt).getTime() + EVENT_WEATHER_DELIVERY_LEASE_MS
    ).toISOString();
    const claimId = randomUUID();
    const result = db.run(
      `UPDATE event_weather_deliveries
          SET status = 'sending',
              claim_id = ?,
              lease_expires_at = ?,
              next_run_at = NULL,
              updated_at = ?
        WHERE event_id = ?
          AND kind = ?
          AND event_updated_at = ?
          AND EXISTS (
            SELECT 1 FROM event_records
             WHERE event_records.id = event_weather_deliveries.event_id
               AND event_records.updated_at = event_weather_deliveries.event_updated_at
          )
          AND chat_id IS NOT NULL
          AND (meteorological_text IS NOT NULL OR marine_text IS NOT NULL)
          AND (
            (status = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?))
            OR (status = 'sending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )`,
      claimId,
      leaseExpiresAt,
      claimedAt,
      input.eventId,
      input.kind,
      input.eventUpdatedAt,
      claimedAt,
      claimedAt
    );
    if (result.changes !== 1) {
      return undefined;
    }
    const delivery = getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
    if (!delivery || delivery.status !== 'sending' || delivery.claimId !== claimId) {
      throw new Error(`Could not read claimed weather delivery ${input.eventId}/${input.kind}.`);
    }
    return { claimId, delivery };
  });
}

export function completeEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  claimId: string;
  meteorologicalMessageId?: string | undefined;
  marineMessageId?: string | undefined;
  completedAt?: string | undefined;
}): boolean {
  const completedAt = input.completedAt ?? new Date().toISOString();
  const result = db.run(
    `UPDATE event_weather_deliveries
        SET status = 'sent',
            meteorological_message_id = ?,
            marine_message_id = ?,
            claim_id = NULL,
            lease_expires_at = NULL,
            next_run_at = NULL,
            sent_at = ?,
            error = NULL,
            updated_at = ?
      WHERE event_id = ?
        AND kind = ?
        AND event_updated_at = ?
        AND status = 'sending'
        AND claim_id = ?
        AND EXISTS (
          SELECT 1 FROM event_records
           WHERE event_records.id = event_weather_deliveries.event_id
             AND event_records.updated_at = event_weather_deliveries.event_updated_at
        )`,
    input.meteorologicalMessageId?.trim() ?? null,
    input.marineMessageId?.trim() ?? null,
    completedAt,
    completedAt,
    input.eventId,
    input.kind,
    input.eventUpdatedAt,
    input.claimId
  );
  return result.changes === 1;
}

export function deferEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  scheduleKind: EventWeatherDeliveryScheduleKind;
  scheduledAt: string;
  nextRunAt: string;
  reason: string;
  claimId?: string | undefined;
  updatedAt?: string | undefined;
}): StoredEventWeatherDelivery | undefined {
  return db.transaction(() => {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const existing = getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
    if (existing?.status === 'sent' || existing?.status === 'skipped') {
      return existing;
    }
    if (!eventRecordVersionMatches(db, input.eventId, input.eventUpdatedAt)) {
      return existing;
    }
    if (input.claimId && existing?.claimId !== input.claimId) {
      return existing;
    }
    if (!existing) {
      db.run(
        `INSERT INTO event_weather_deliveries (
           event_id, event_updated_at, kind, schedule_kind, scheduled_at, status, attempt,
           next_run_at, error, updated_at
         )
         SELECT ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?
           FROM event_records
          WHERE id = ? AND updated_at = ?`,
        input.eventId,
        input.eventUpdatedAt,
        input.kind,
        input.scheduleKind,
        input.scheduledAt,
        input.nextRunAt,
        input.reason,
        updatedAt,
        input.eventId,
        input.eventUpdatedAt
      );
    } else {
      db.run(
        `UPDATE event_weather_deliveries
            SET schedule_kind = ?,
                scheduled_at = ?,
                status = 'pending',
                claim_id = NULL,
                lease_expires_at = NULL,
                attempt = attempt + 1,
                next_run_at = ?,
                error = ?,
                updated_at = ?
          WHERE event_id = ? AND kind = ? AND event_updated_at = ?`,
        input.scheduleKind,
        input.scheduledAt,
        input.nextRunAt,
        input.reason,
        updatedAt,
        input.eventId,
        input.kind,
        input.eventUpdatedAt
      );
    }
    return getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
  });
}

export function skipEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  scheduleKind: EventWeatherDeliveryScheduleKind;
  scheduledAt: string;
  reason: string;
  skippedAt?: string | undefined;
}): StoredEventWeatherDelivery | undefined {
  return db.transaction(() => {
    const skippedAt = input.skippedAt ?? new Date().toISOString();
    db.run(
    `INSERT INTO event_weather_deliveries (
       event_id, event_updated_at, kind, schedule_kind, scheduled_at, status, attempt,
       skipped_at, error, updated_at
     )
     SELECT ?, ?, ?, ?, ?, 'skipped', 0, ?, ?, ?
       FROM event_records
      WHERE id = ? AND updated_at = ?
     ON CONFLICT(event_id, kind, event_updated_at) DO UPDATE SET
       schedule_kind = excluded.schedule_kind,
       scheduled_at = excluded.scheduled_at,
       status = 'skipped',
       claim_id = NULL,
       lease_expires_at = NULL,
       next_run_at = NULL,
       sent_at = NULL,
       skipped_at = excluded.skipped_at,
       error = excluded.error,
       updated_at = excluded.updated_at
     WHERE event_weather_deliveries.status <> 'sent'
       AND EXISTS (
         SELECT 1 FROM event_records
          WHERE event_records.id = event_weather_deliveries.event_id
            AND event_records.updated_at = event_weather_deliveries.event_updated_at
       )`,
    input.eventId,
    input.eventUpdatedAt,
    input.kind,
    input.scheduleKind,
    input.scheduledAt,
    skippedAt,
    input.reason,
    skippedAt,
    input.eventId,
    input.eventUpdatedAt
    );
    return getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
  });
}

export function supersedeEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  reason: string;
  supersededAt?: string | undefined;
}): StoredEventWeatherDelivery | undefined {
  const supersededAt = input.supersededAt ?? new Date().toISOString();
  db.run(
    `UPDATE event_weather_deliveries
        SET status = 'skipped',
            claim_id = NULL,
            lease_expires_at = NULL,
            next_run_at = NULL,
            sent_at = NULL,
            skipped_at = ?,
            error = ?,
            updated_at = ?
      WHERE event_id = ?
        AND event_updated_at = ?
        AND kind = ?
        AND status IN ('pending', 'sending')`,
    supersededAt,
    input.reason,
    supersededAt,
    input.eventId,
    input.eventUpdatedAt,
    input.kind
  );
  return getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
}

function eventRecordVersionMatches(
  db: PluginDatabase,
  eventId: string,
  eventUpdatedAt: string
): boolean {
  return Boolean(db.get<{ id: string }>(
    'SELECT id FROM event_records WHERE id = ? AND updated_at = ?',
    eventId,
    eventUpdatedAt
  ));
}

export function recordCalendarPublicationStatus(db: PluginDatabase, input: {
  scopeId: string;
  calendarId: string;
  generation: number;
  generatedAt: string;
  generatedEventCount: number;
  publication?: CalendarPublicationOutcome | undefined;
}): void {
  const publication = input.publication;
  const updatedAt = new Date().toISOString();
  const lastSuccessAt = publication?.ok ? publication.updatedAt || updatedAt : null;
  const lastErrorAt = publication && !publication.ok ? updatedAt : null;
  const lastError = publication && !publication.ok ? publication.error || 'Calendar publication failed.' : null;
  db.run(
    `INSERT INTO event_calendar_publication_status (
       scope_id, calendar_id, generation, generated_at, generated_event_count,
       publication_enabled, attempted, ok, endpoint_url, feed_id, label,
       subscription_url, calendar_url, target_updated_at, last_success_at,
       last_error_at, last_error, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_id, calendar_id) DO UPDATE SET
       generation = excluded.generation,
       generated_at = excluded.generated_at,
       generated_event_count = excluded.generated_event_count,
       publication_enabled = excluded.publication_enabled,
       attempted = excluded.attempted,
       ok = excluded.ok,
       endpoint_url = excluded.endpoint_url,
       feed_id = excluded.feed_id,
       label = excluded.label,
       subscription_url = CASE
         WHEN excluded.endpoint_url IS event_calendar_publication_status.endpoint_url
          AND excluded.feed_id IS event_calendar_publication_status.feed_id
           THEN COALESCE(excluded.subscription_url, event_calendar_publication_status.subscription_url)
         ELSE excluded.subscription_url
       END,
       calendar_url = CASE
         WHEN excluded.endpoint_url IS event_calendar_publication_status.endpoint_url
          AND excluded.feed_id IS event_calendar_publication_status.feed_id
           THEN COALESCE(excluded.calendar_url, event_calendar_publication_status.calendar_url)
         ELSE excluded.calendar_url
       END,
       target_updated_at = CASE
         WHEN excluded.endpoint_url IS event_calendar_publication_status.endpoint_url
          AND excluded.feed_id IS event_calendar_publication_status.feed_id
           THEN COALESCE(excluded.target_updated_at, event_calendar_publication_status.target_updated_at)
         ELSE excluded.target_updated_at
       END,
       last_success_at = CASE
         WHEN excluded.last_success_at IS NOT NULL THEN excluded.last_success_at
         WHEN excluded.endpoint_url IS NOT event_calendar_publication_status.endpoint_url
           OR excluded.feed_id IS NOT event_calendar_publication_status.feed_id THEN NULL
         ELSE event_calendar_publication_status.last_success_at
       END,
       last_error_at = CASE
         WHEN excluded.last_error_at IS NOT NULL THEN excluded.last_error_at
         WHEN excluded.ok = 1 THEN NULL
         ELSE event_calendar_publication_status.last_error_at
       END,
       last_error = CASE
         WHEN excluded.last_error IS NOT NULL THEN excluded.last_error
         WHEN excluded.ok = 1 THEN NULL
         ELSE event_calendar_publication_status.last_error
       END,
       updated_at = excluded.updated_at
     WHERE excluded.generation >= event_calendar_publication_status.generation`,
    input.scopeId,
    input.calendarId,
    input.generation,
    input.generatedAt,
    input.generatedEventCount,
    publication?.enabled ? 1 : 0,
    publication?.attempted ? 1 : 0,
    publication ? (publication.ok ? 1 : 0) : 0,
    publication?.endpointUrl || null,
    publication?.feedId || null,
    publication?.label || null,
    publication?.subscriptionUrl || null,
    publication?.calendarUrl || null,
    publication?.updatedAt || null,
    lastSuccessAt,
    lastErrorAt,
    lastError,
    updatedAt
  );
}

export function getCalendarPublicationStatus(
  db: PluginDatabase,
  scopeId: string,
  calendarId: string
): StoredCalendarPublicationStatus | undefined {
  const row = db.get<CalendarPublicationStatusRow>(
    'SELECT * FROM event_calendar_publication_status WHERE scope_id = ? AND calendar_id = ?',
    scopeId,
    calendarId
  );
  return row ? calendarPublicationStatusFromRow(row) : undefined;
}

export function listCalendarEvents(
  db: PluginDatabase,
  scopeId: string,
  calendarId: string
): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE scope_id = ?
        AND calendar_id = ?
        AND calendar_ownership_status = 'assigned'
        AND calendar_status IN ('included', 'cancelled')
      ORDER BY starts_at ASC, id ASC`,
    scopeId,
    calendarId
  ).map(eventFromRow);
}

export function listUnassignedEventCalendarOwnership(
  db: PluginDatabase,
  scopeId?: string | undefined
): UnassignedEventCalendarOwnership[] {
  const rows = scopeId
    ? db.all<{
      id: string;
      scope_id: string;
      profile_id: string;
      actor_identity_id: string;
    }>(
      `SELECT id, scope_id, profile_id, actor_identity_id
         FROM event_records
        WHERE scope_id = ? AND calendar_ownership_status = 'unresolved'
        ORDER BY profile_id ASC, id ASC`,
      scopeId
    )
    : db.all<{
    id: string;
    scope_id: string;
    profile_id: string;
    actor_identity_id: string;
  }>(
    `SELECT id, scope_id, profile_id, actor_identity_id
       FROM event_records
      WHERE calendar_ownership_status = 'unresolved'
      ORDER BY scope_id ASC, profile_id ASC, id ASC`
  );
  return rows.map((row) => ({
    eventId: row.id,
    scopeId: row.scope_id,
    profileId: row.profile_id,
    actorIdentityId: row.actor_identity_id
  }));
}

export function assertScopeEventCalendarOwnershipResolved(
  db: PluginDatabase,
  scopeId: string
): void {
  const unresolved = listUnassignedEventCalendarOwnership(db, scopeId);
  if (unresolved.length > 0) {
    throw new Error(
      `Calendar publication for scope ${scopeId} is blocked until authoritative ownership is assigned for events: ${unresolved.map((event) => event.eventId).join(', ')}.`
    );
  }
}

/**
 * Persists a migration decision exactly once. Runtime calendar rendering never
 * infers ownership from profile configuration.
 */
export function assignUnassignedEventCalendarOwnership(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  profileId: string;
  calendarId: string | null;
  source: string;
}): boolean {
  const calendarId = input.calendarId?.trim() || null;
  const calendarOwnershipStatus: EventCalendarOwnershipStatus = calendarId ? 'assigned' : 'none';
  const source = input.source.trim();
  if (!source) {
    throw new Error('Calendar ownership assignment source is required.');
  }
  return db.transaction(() => {
    return assignUnassignedEventCalendarOwnershipInTransaction(db, {
      ...input,
      calendarId,
      calendarOwnershipStatus,
      source
    });
  });
}

export function assignUnassignedEventCalendarOwnershipBatch(db: PluginDatabase, input: {
  assignments: Array<{
    eventId: string;
    scopeId: string;
    profileId: string;
    calendarId: string | null;
  }>;
  source: string;
}): { assigned: string[]; alreadyAssigned: string[] } {
  const source = input.source.trim();
  if (!source) {
    throw new Error('Calendar ownership assignment source is required.');
  }
  const duplicateIds = input.assignments
    .map((assignment) => assignment.eventId)
    .filter((eventId, index, values) => values.indexOf(eventId) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`Duplicate event calendar ownership assignments: ${[...new Set(duplicateIds)].join(', ')}.`);
  }
  return db.transaction(() => {
    const assigned: string[] = [];
    const alreadyAssigned: string[] = [];
    for (const assignment of input.assignments) {
      const event = getEvent(db, assignment.eventId);
      if (
        !event ||
        event.scopeId !== assignment.scopeId ||
        event.profileId !== assignment.profileId
      ) {
        throw new Error(`Event calendar ownership preflight failed for ${assignment.eventId}.`);
      }
      const requestedCalendarId = assignment.calendarId?.trim() || null;
      if (event.calendarOwnershipStatus === 'unresolved') {
        const changed = assignUnassignedEventCalendarOwnershipInTransaction(db, {
          ...assignment,
          calendarId: requestedCalendarId,
          calendarOwnershipStatus: requestedCalendarId ? 'assigned' : 'none',
          source
        });
        if (!changed) {
          throw new Error(`Event calendar ownership changed during assignment for ${assignment.eventId}.`);
        }
        assigned.push(assignment.eventId);
        continue;
      }

      const currentCalendarId = resolvedEventCalendarId(event) ?? null;
      const matchingAudit = db.get<{ id: string; metadata_json: string }>(
        `SELECT id, metadata_json
           FROM event_logs
          WHERE event_id = ?
            AND action = 'events.calendar_ownership.assigned'
            AND json_extract(metadata_json, '$.source') = ?
            AND json_extract(metadata_json, '$.calendarId') IS ?
          LIMIT 1`,
        assignment.eventId,
        source,
        requestedCalendarId
      );
      if (
        currentCalendarId !== requestedCalendarId ||
        !matchingAudit
      ) {
        throw new Error(`Event calendar ownership is already resolved differently for ${assignment.eventId}.`);
      }
      alreadyAssigned.push(assignment.eventId);
    }
    return { assigned, alreadyAssigned };
  });
}

function assignUnassignedEventCalendarOwnershipInTransaction(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  profileId: string;
  calendarId: string | null;
  calendarOwnershipStatus: Exclude<EventCalendarOwnershipStatus, 'unresolved'>;
  source: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET calendar_id = ?,
            calendar_ownership_status = ?
      WHERE id = ?
        AND scope_id = ?
        AND profile_id = ?
        AND calendar_ownership_status = 'unresolved'`,
    input.calendarId,
    input.calendarOwnershipStatus,
    input.eventId,
    input.scopeId,
    input.profileId
  );
  if (result.changes !== 1) {
    return false;
  }
  appendEventLog(db, {
    eventId: input.eventId,
    action: 'events.calendar_ownership.assigned',
    metadata: {
      scopeId: input.scopeId,
      profileId: input.profileId,
      calendarId: input.calendarId,
      calendarOwnershipStatus: input.calendarOwnershipStatus,
      source: input.source
    }
  });
  return true;
}

export function listScopeEvents(db: PluginDatabase, scopeId: string): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE scope_id = ?
      ORDER BY starts_at ASC, id ASC`,
    scopeId
  ).map(eventFromRow);
}

function eventFromRow(row: EventRow): StoredEventRecord {
  const eventLocation = parseStoredEventLocation(row.event_location_json);
  return {
    id: row.id,
    scopeId: row.scope_id,
    ...(row.group_id ? { groupId: row.group_id } : {}),
    ...(row.group_wid ? { groupWid: row.group_wid } : {}),
    profileId: row.profile_id,
    profileRevision: row.profile_revision ?? '',
    profileLabel: row.profile_label,
    origin: row.origin ?? 'created',
    eventStatus: row.event_status,
    groupLifecycleStatus: row.group_lifecycle_status,
    calendarStatus: row.calendar_status,
    calendarId: row.calendar_id?.trim() || null,
    calendarOwnershipStatus: row.calendar_ownership_status,
    ...(row.actor_identity_id ? { actorIdentityId: row.actor_identity_id } : {}),
    actorWid: row.actor_wid,
    actorLabel: row.actor_label,
    ...(row.announcement_group_wid ? { announcementGroupWid: row.announcement_group_wid } : {}),
    ...(row.poll_wa_msg_id ? { pollWaMsgId: row.poll_wa_msg_id } : {}),
    pollGeneration: Number(row.poll_generation ?? (row.poll_wa_msg_id ? 1 : 0)),
    ...(row.poll_question ? { pollQuestion: row.poll_question } : {}),
    pollOptions: parseJson<StoredEventPollOption[]>(row.poll_options_json, []),
    responseClasses: parseJson<StoredEventResponseClass[]>(row.response_classes_json, []),
    answers: parseJson<Record<string, string>>(row.answers_json, {}),
    ...(eventLocation ? { eventLocation } : {}),
    startsAt: row.starts_at,
    startsAtUtc: row.starts_at_utc || row.starts_at,
    endsAt: row.ends_at || new Date(
      new Date(row.starts_at).getTime() + Number(row.calendar_duration_minutes) * 60_000
    ).toISOString(),
    lifecycleCompleteAt: row.lifecycle_complete_at || row.ends_at || new Date(
      new Date(row.starts_at).getTime() + Number(row.calendar_duration_minutes) * 60_000
    ).toISOString(),
    spanKind: row.span_kind ?? inferredEventSpanKind(Number(row.calendar_duration_minutes)),
    timezone: row.timezone,
    ...(row.local_date ? { localDate: row.local_date } : {}),
    ...(row.local_time ? { localTime: row.local_time } : {}),
    ...(row.place ? { place: row.place } : {}),
    closeAt: row.close_at,
    cleanupAt: row.cleanup_at,
    groupTitle: row.group_title,
    calendarDurationMinutes: Number(row.calendar_duration_minutes),
    ...(row.calendar_location ? { calendarLocation: row.calendar_location } : {}),
    ...(row.calendar_description ? { calendarDescription: row.calendar_description } : {}),
    ...(row.subgroup_chat_id ? { subgroupChatId: row.subgroup_chat_id } : {}),
    ...(row.subgroup_title ? { subgroupTitle: row.subgroup_title } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
    ...(row.cleaned_at ? { cleanedAt: row.cleaned_at } : {}),
    ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
    ...(row.cancelled_by_wid ? { cancelledByWid: row.cancelled_by_wid } : {}),
    ...(row.cancelled_by_label ? { cancelledByLabel: row.cancelled_by_label } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.provisioning_recovery_generation
      ? { provisioningRecoveryGeneration: row.provisioning_recovery_generation }
      : {}),
    ...(row.provisioning_recovery_attempt !== null
      ? { provisioningRecoveryAttempt: Number(row.provisioning_recovery_attempt) }
      : {}),
    ...(row.provisioning_recovery_next_run_at
      ? { provisioningRecoveryNextRunAt: row.provisioning_recovery_next_run_at }
      : {}),
    ...(row.provisioning_recovery_halted_at
      ? { provisioningRecoveryHaltedAt: row.provisioning_recovery_halted_at }
      : {})
  };
}

function requireEventPollReplacement(
  db: PluginDatabase,
  operationId: string
): StoredEventPollReplacement {
  const replacement = getEventPollReplacement(db, operationId);
  if (!replacement) {
    throw new Error(`Event poll replacement ${operationId} does not exist.`);
  }
  return replacement;
}

function eventPollReplacementFromRow(row: EventPollReplacementRow): StoredEventPollReplacement {
  return {
    operationId: row.operation_id,
    eventId: row.event_id,
    scopeId: row.scope_id,
    status: row.status,
    expectedEventUpdatedAt: row.expected_event_updated_at,
    oldPollWaMsgId: row.old_poll_wa_msg_id,
    oldPollGeneration: Number(row.old_poll_generation),
    target: parseJson<EventPollReplacementTarget>(row.target_json, {
      profileLabel: '',
      profileRevision: '',
      pollQuestion: '',
      pollOptions: [],
      responseClasses: [],
      answers: {},
      startsAt: '',
      startsAtUtc: '',
      endsAt: '',
      spanKind: 'day_trip',
      timezone: 'UTC',
      localDate: '',
      closeAt: '',
      cleanupAt: '',
      groupTitle: '',
      calendarDurationMinutes: 0,
      allowMultipleAnswers: false
    }),
    editorIdentityId: row.editor_identity_id,
    editorWid: row.editor_wid,
    editorLabel: row.editor_label,
    locale: row.locale,
    sourcePluginId: row.source_plugin_id,
    artifactIds: parseJson<string[]>(row.artifact_ids_json, []),
    publishIdempotencyKey: row.publish_idempotency_key,
    ...(row.new_poll_wa_msg_id ? { newPollWaMsgId: row.new_poll_wa_msg_id } : {}),
    ...(row.publication_claim_token
      ? { publicationClaimToken: row.publication_claim_token }
      : {}),
    ...(row.publication_lease_expires_at
      ? { publicationLeaseExpiresAt: row.publication_lease_expires_at }
      : {}),
    ...(row.publication_started_at ? { publicationStartedAt: row.publication_started_at } : {}),
    failureCount: Number(row.failure_count),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.published_at ? { publishedAt: row.published_at } : {}),
    ...(row.swapped_at ? { swappedAt: row.swapped_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.retired_at ? { retiredAt: row.retired_at } : {}),
    ...(row.retirement_error ? { retirementError: row.retirement_error } : {}),
    retirementFailureCount: Number(row.retirement_failure_count),
    ...(row.receipt_released_at ? { receiptReleasedAt: row.receipt_released_at } : {}),
    ...(row.receipt_release_error ? { receiptReleaseError: row.receipt_release_error } : {}),
    receiptReleaseFailureCount: Number(row.receipt_release_failure_count),
    ...(row.receipt_release_next_attempt_at
      ? { receiptReleaseNextAttemptAt: row.receipt_release_next_attempt_at }
      : {})
  };
}

function eventAnnouncementMessageFromRow(row: EventAnnouncementMessageRow): StoredEventAnnouncementMessage {
  return {
    id: row.id,
    eventId: row.event_id,
    scopeId: row.scope_id,
    kind: row.kind,
    deliveryKey: row.delivery_key,
    chatId: row.chat_id,
    messageId: row.message_id,
    createdAt: row.created_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    ...(row.delete_error ? { deleteError: row.delete_error } : {}),
    ...(row.deletion_status ? { deletionStatus: row.deletion_status } : {}),
    deletionAttemptCount: Number(row.deletion_attempt_count ?? 0),
    ...(row.deletion_next_attempt_at ? { deletionNextAttemptAt: row.deletion_next_attempt_at } : {}),
    ...(row.deletion_submitted_at ? { deletionSubmittedAt: row.deletion_submitted_at } : {}),
    ...(row.deletion_confirmed_at ? { deletionConfirmedAt: row.deletion_confirmed_at } : {}),
    ...(row.deletion_finalized_at ? { deletionFinalizedAt: row.deletion_finalized_at } : {}),
    ...(row.deletion_last_error ? { deletionLastError: row.deletion_last_error } : {})
  };
}

function eventAnnouncementDeliveryClaimFromRow(
  row: EventAnnouncementDeliveryClaimRow
): StoredEventAnnouncementDeliveryClaim {
  const calendarHintIntent = eventCalendarHintDeliveryIntentFromJson(
    row.calendar_hint_intent_json
  );
  return {
    eventId: row.event_id,
    kind: row.kind,
    deliveryKey: row.delivery_key,
    scopeId: row.scope_id,
    chatId: row.chat_id,
    status: row.status,
    ...(row.text ? { text: row.text } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(calendarHintIntent ? { calendarHintIntent } : {}),
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at
  };
}

function eventEditRepairFromRow(row: EventEditRepairRow): StoredEventEditRepair {
  return {
    operationId: row.operation_id,
    eventId: row.event_id,
    scopeId: row.scope_id,
    expectedEventUpdatedAt: row.expected_event_updated_at,
    ...(row.subgroup_chat_id ? { subgroupChatId: row.subgroup_chat_id } : {}),
    targetGroupTitle: row.target_group_title,
    calendarId: row.calendar_id,
    ...(row.announcement_delivery_key
      ? { announcementDeliveryKey: row.announcement_delivery_key }
      : {}),
    ...(row.calendar_hint_delivery_key
      ? { calendarHintDeliveryKey: row.calendar_hint_delivery_key }
      : {}),
    ...(row.calendar_hint_locale ? { calendarHintLocale: row.calendar_hint_locale } : {}),
    status: row.status,
    ...(row.execution_claim_id ? { executionClaimId: row.execution_claim_id } : {}),
    ...(row.execution_lease_expires_at
      ? { executionLeaseExpiresAt: row.execution_lease_expires_at }
      : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {})
  };
}

function eventCleanupClaimFromRow(row: EventCleanupClaimRow): EventCleanupClaim {
  return {
    eventId: row.event_id,
    claimId: row.claim_id,
    expectedEventUpdatedAt: row.expected_event_updated_at,
    claimedCleanupAt: row.claimed_cleanup_at,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at
  };
}

function normalizedEventAnnouncementIntent(
  input: EventAnnouncementDeliveryIntent
): EventAnnouncementDeliveryIntent {
  const scopeId = requiredEventOperationValue(input.scopeId, 'announcement scope id');
  const deliveryKey = requiredEventOperationValue(input.deliveryKey, 'announcement delivery key');
  const chatId = requiredEventOperationValue(input.chatId, 'announcement chat id');
  const text = requiredEventOperationValue(input.text, 'announcement text', false);
  const idempotencyKey = requiredEventOperationValue(input.idempotencyKey, 'announcement idempotency key');
  return { scopeId, kind: input.kind, deliveryKey, chatId, text, idempotencyKey };
}

function normalizedEventCalendarHintDeliveryIntent(
  input: EventCalendarHintDeliveryIntent
): EventCalendarHintDeliveryIntent {
  const trigger = input.trigger;
  if (!['poll_published', 'unplanned_created', 'unplanned_recovery'].includes(trigger)) {
    throw new Error(`Unknown calendar-hint trigger: ${String(trigger)}`);
  }
  const calendarId = requiredEventOperationValue(input.calendarId, 'calendar-hint calendar id');
  const locale = requiredEventOperationValue(input.locale, 'calendar-hint locale');
  const timezone = requiredEventOperationValue(input.timezone, 'calendar-hint timezone');
  const creatorDisplayName = requiredEventOperationValue(
    input.creatorDisplayName,
    'calendar-hint creator display name',
    false
  );
  const expectedEventUpdatedAt = requiredEventOperationValue(
    input.expectedEventUpdatedAt,
    'calendar-hint event revision'
  );
  const groupJoinUrl = input.groupJoinUrl?.trim() || undefined;
  const subgroupChatId = input.subgroupChatId?.trim() || undefined;
  return {
    trigger,
    calendarId,
    locale,
    timezone,
    creatorDisplayName,
    expectedEventUpdatedAt,
    ...(groupJoinUrl ? { groupJoinUrl } : {}),
    ...(subgroupChatId ? { subgroupChatId } : {})
  };
}

function eventCalendarHintDeliveryIntentFromJson(
  value: string | null
): EventCalendarHintDeliveryIntent | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Partial<EventCalendarHintDeliveryIntent>;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    return normalizedEventCalendarHintDeliveryIntent(parsed as EventCalendarHintDeliveryIntent);
  } catch {
    return undefined;
  }
}

function normalizedEventEditRepairIntent(input: EventEditRepairIntent): EventEditRepairIntent {
  const operationId = requiredEventOperationValue(input.operationId, 'edit operation id');
  const scopeId = requiredEventOperationValue(input.scopeId, 'edit scope id');
  const targetGroupTitle = requiredEventOperationValue(input.targetGroupTitle, 'edit target group title', false);
  const calendarId = input.calendarId.trim();
  const subgroupChatId = input.subgroupChatId?.trim() || undefined;
  const announcementDeliveryKey = input.announcementDeliveryKey?.trim() || undefined;
  const calendarHintDeliveryKey = input.calendarHintDeliveryKey?.trim() || undefined;
  const calendarHintLocale = input.calendarHintLocale?.trim() || undefined;
  if (Boolean(calendarHintDeliveryKey) !== Boolean(calendarHintLocale)) {
    throw new Error('Event calendar-hint delivery key and locale must be persisted together.');
  }
  return {
    operationId,
    scopeId,
    ...(subgroupChatId ? { subgroupChatId } : {}),
    targetGroupTitle,
    calendarId,
    ...(announcementDeliveryKey ? { announcementDeliveryKey } : {}),
    ...(calendarHintDeliveryKey ? { calendarHintDeliveryKey } : {}),
    ...(calendarHintLocale ? { calendarHintLocale } : {})
  };
}

function requiredEventOperationValue(value: string, label: string, trim = true): string {
  if (!value.trim()) {
    throw new Error(`Event ${label} is required.`);
  }
  return trim ? value.trim() : value;
}

function parseStoredEventLocation(value: string | null): StoredEventLocation | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseJson<unknown>(value, undefined);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const location = parsed as Record<string, unknown>;
  if (
    (location.source !== 'question' && location.source !== 'fixed') ||
    typeof location.displayLabel !== 'string' ||
    !location.displayLabel.trim() ||
    typeof location.resolvedLabel !== 'string' ||
    !location.resolvedLabel.trim() ||
    typeof location.latitude !== 'number' ||
    !Number.isFinite(location.latitude) ||
    location.latitude < -90 ||
    location.latitude > 90 ||
    typeof location.longitude !== 'number' ||
    !Number.isFinite(location.longitude) ||
    location.longitude < -180 ||
    location.longitude > 180 ||
    typeof location.timezone !== 'string' ||
    !location.timezone.trim()
  ) {
    return undefined;
  }
  return {
    source: location.source,
    displayLabel: location.displayLabel,
    resolvedLabel: location.resolvedLabel,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: location.timezone,
    ...(typeof location.query === 'string' && location.query.trim() ? { query: location.query } : {}),
    ...(typeof location.provider === 'string' && location.provider.trim() ? { provider: location.provider } : {}),
    ...(typeof location.providerRef === 'string' && location.providerRef.trim()
      ? { providerRef: location.providerRef }
      : {})
  };
}

function voteFromRow(row: VoteRow): StoredEventVote {
  return {
    eventId: row.event_id,
    voterIdentityId: row.voter_identity_id,
    voterWid: row.voter_wid,
    selectedOptionIds: parseJson<string[]>(row.selected_option_ids_json, []),
    selectedOptionNames: parseJson<string[]>(row.selected_option_names_json, []),
    selectedOptionNumbers: parseJson<number[]>(row.selected_option_numbers_json, []),
    ...(row.interacted_at ? { interactedAt: row.interacted_at } : {}),
    updatedAt: row.updated_at
  };
}

function calendarPublicationStatusFromRow(row: CalendarPublicationStatusRow): StoredCalendarPublicationStatus {
  return {
    scopeId: row.scope_id,
    calendarId: row.calendar_id,
    generation: Number(row.generation),
    generatedAt: row.generated_at,
    generatedEventCount: Number(row.generated_event_count),
    publicationEnabled: row.publication_enabled === 1,
    attempted: row.attempted === 1,
    ok: row.ok === 1,
    ...(row.endpoint_url ? { endpointUrl: row.endpoint_url } : {}),
    ...(row.feed_id ? { feedId: row.feed_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.subscription_url ? { subscriptionUrl: row.subscription_url } : {}),
    ...(row.calendar_url ? { calendarUrl: row.calendar_url } : {}),
    ...(row.target_updated_at ? { targetUpdatedAt: row.target_updated_at } : {}),
    ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
    ...(row.last_error_at ? { lastErrorAt: row.last_error_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    updatedAt: row.updated_at
  };
}

function eventCalendarPublicationGenerationFromRow(
  row: EventCalendarPublicationGenerationRow
): StoredEventCalendarPublicationGeneration {
  return {
    scopeId: row.scope_id,
    calendarId: row.calendar_id,
    requestedGeneration: Number(row.requested_generation),
    localGeneration: Number(row.local_generation),
    completedGeneration: Number(row.completed_generation),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_generation !== null ? { leaseGeneration: Number(row.lease_generation) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    failureCount: Number(row.failure_count),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.requested_config_fingerprint
      ? { requestedConfigFingerprint: row.requested_config_fingerprint }
      : {}),
    ...(row.document_generation !== null
      ? { documentGeneration: Number(row.document_generation) }
      : {}),
    ...(row.document_body !== null ? { documentBody: row.document_body } : {}),
    ...(row.document_sha256 ? { documentSha256: row.document_sha256 } : {}),
    ...(row.document_config_fingerprint
      ? { documentConfigFingerprint: row.document_config_fingerprint }
      : {}),
    ...(row.document_calendar_json
      ? { documentCalendarJson: row.document_calendar_json }
      : {}),
    ...(row.document_events_json
      ? { documentEventsJson: row.document_events_json }
      : {}),
    ...(row.document_generated_at ? { documentGeneratedAt: row.document_generated_at } : {}),
    ...(row.document_event_count !== null
      ? { documentEventCount: Number(row.document_event_count) }
      : {}),
    ...(row.completed_config_fingerprint
      ? { completedConfigFingerprint: row.completed_config_fingerprint }
      : {}),
    updatedAt: row.updated_at
  };
}

function eventWeatherDeliveryFromRow(row: EventWeatherDeliveryRow): StoredEventWeatherDelivery {
  return {
    eventId: row.event_id,
    eventUpdatedAt: row.event_updated_at,
    kind: row.kind,
    scheduleKind: row.schedule_kind,
    scheduledAt: row.scheduled_at,
    status: row.status,
    ...(row.chat_id ? { chatId: row.chat_id } : {}),
    ...(row.meteorological_text ? { meteorologicalText: row.meteorological_text } : {}),
    ...(row.marine_text ? { marineText: row.marine_text } : {}),
    ...(row.meteorological_idempotency_key
      ? { meteorologicalIdempotencyKey: row.meteorological_idempotency_key }
      : {}),
    ...(row.marine_idempotency_key ? { marineIdempotencyKey: row.marine_idempotency_key } : {}),
    ...(row.meteorological_message_id ? { meteorologicalMessageId: row.meteorological_message_id } : {}),
    ...(row.marine_message_id ? { marineMessageId: row.marine_message_id } : {}),
    ...(row.claim_id ? { claimId: row.claim_id } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    attempt: Number(row.attempt),
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    ...(row.sent_at ? { sentAt: row.sent_at } : {}),
    ...(row.skipped_at ? { skippedAt: row.skipped_at } : {}),
    ...(row.error ? { error: row.error } : {}),
    updatedAt: row.updated_at
  };
}

function unplannedEventFinalizationFromRow(
  row: UnplannedEventFinalizationRow
): StoredUnplannedEventFinalization {
  return {
    eventId: row.event_id,
    scopeId: row.scope_id,
    eventUpdatedAt: row.event_updated_at,
    generation: row.generation,
    attempt: Number(row.attempt),
    status: row.status,
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {})
  };
}

function eventQuestionKeyRenameFromRow(row: EventQuestionKeyRenameRow): StoredEventQuestionKeyRename {
  return {
    operationId: row.operation_id,
    scopeId: row.scope_id,
    profileId: row.profile_id,
    oldKey: row.old_key,
    newKey: row.new_key,
    oldProfileRevision: row.old_profile_revision ?? '',
    newProfileRevision: row.new_profile_revision ?? '',
    status: row.status,
    migratedEventCount: row.migrated_event_count,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireEventQuestionKeyRenameRow(db: PluginDatabase, operationId: string): EventQuestionKeyRenameRow {
  const row = db.get<EventQuestionKeyRenameRow>(
    'SELECT * FROM event_question_key_renames WHERE operation_id = ?',
    operationId
  );
  if (!row) {
    throw new EventQuestionKeyRenameConflictError(`Unknown event question-key rename operation: ${operationId}`);
  }
  return row;
}

function parseEventAnswersForQuestionKeyRename(eventId: string, value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new EventQuestionKeyRenameConflictError(
      `Event ${eventId} has invalid stored answers and cannot be migrated safely.`
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((answer) => typeof answer !== 'string')
  ) {
    throw new EventQuestionKeyRenameConflictError(
      `Event ${eventId} has invalid stored answers and cannot be migrated safely.`
    );
  }
  return parsed as Record<string, string>;
}

function eventAnswerJsonPath(key: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
    throw new EventQuestionKeyRenameConflictError(`Invalid event question key: ${key}`);
  }
  return `$."${key}"`;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
