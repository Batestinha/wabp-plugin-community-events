import {
  COMMUNITY_SUBGROUPS_SERVICE_ID,
  COMMUNITY_SUBGROUPS_COMPLETE_METHOD
} from './contracts/community-subgroups/serviceApi';

/** The complete operation only verifies an existing parent link. A lost
 * service result can therefore be retried against the exact checkpointed
 * child without creating or linking another group. Other unknown outcomes
 * must keep the operator fence.
 */
export function isKnownChildCompletionTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes('Plugin service call timed out after ') &&
    error.message.endsWith(`${COMMUNITY_SUBGROUPS_SERVICE_ID}.${COMMUNITY_SUBGROUPS_COMPLETE_METHOD}`);
}
