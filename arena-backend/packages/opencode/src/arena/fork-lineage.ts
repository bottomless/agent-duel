import { isFinalState } from "./domain"
import type { BattleHistoryTurn, ForkLineageDocument } from "./records"

/** How many forks of forks a chat's history follows back. */
export const MAX_FORK_DEPTH = 16

/**
 * The source chat's decided battles that a fork copied, under the fork's message IDs. A battle
 * belongs to the fork when the fork copied its prompt; its kept answer then runs to the copy of its
 * last message, or to the end of the copy when the fork cut it short. A battle that kept no answer
 * has no message, so it belongs when it was sent before the last copied message was written. A
 * battle still running when the fork was made wrote nothing the fork copied and stays out.
 */
export function inheritTurns(
  turns: readonly BattleHistoryTurn[],
  lineage: Pick<ForkLineageDocument, "messages" | "throughTime">,
): BattleHistoryTurn[] {
  const copies = new Map(Object.entries(lineage.messages))
  const lastCopy = [...copies.values()].sort().at(-1)
  const inherited: BattleHistoryTurn[] = []
  for (const turn of turns) {
    if (!isFinalState(turn.state)) continue
    if (turn.canonicalUserMessageID) {
      const first = copies.get(turn.canonicalUserMessageID)
      if (!first) continue
      const { canonicalLastMessageID: last, ...rest } = turn
      const end = last ? (copies.get(last) ?? lastCopy) : undefined
      inherited.push({ ...rest, canonicalUserMessageID: first, ...(end ? { canonicalLastMessageID: end } : {}) })
      continue
    }
    if (lineage.throughTime !== undefined && new Date(turn.createdAt).getTime() <= lineage.throughTime) {
      inherited.push(turn)
    }
  }
  return inherited
}

export * as ArenaForkLineage from "./fork-lineage"
