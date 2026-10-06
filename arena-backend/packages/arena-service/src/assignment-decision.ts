export const BattleAssignmentDecision = ["select:a", "select:b", "tie", "discard", "aborted"] as const
export type BattleAssignmentDecision = (typeof BattleAssignmentDecision)[number]

export const SingleAssignmentDecision = ["rate:up", "rate:down"] as const
export type SingleAssignmentDecision = (typeof SingleAssignmentDecision)[number]

export type AssignmentDecision = BattleAssignmentDecision | SingleAssignmentDecision

export function isAssignmentDecision(kind: "battle" | "single", value: unknown): value is AssignmentDecision {
  if (typeof value !== "string") return false
  return kind === "battle"
    ? BattleAssignmentDecision.some((decision) => decision === value)
    : SingleAssignmentDecision.some((decision) => decision === value)
}

export * as ArenaAssignmentDecision from "./assignment-decision"
