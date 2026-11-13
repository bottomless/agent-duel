/** Measurement only: this route never makes a model request. */
export const COMPACTION_POLICY_PATH = "/api/v1/compaction-policy"
export const COMPACTION_TURNS_HEADER = "x-arena-completed-turns"

export function eligibleForCompaction(completedUserTurns: number, reasoningShare: number | null) {
  return (
    Number.isSafeInteger(completedUserTurns) &&
    completedUserTurns >= 2 &&
    reasoningShare !== null &&
    Number.isFinite(reasoningShare) &&
    reasoningShare >= 0.2 &&
    reasoningShare <= 1
  )
}
