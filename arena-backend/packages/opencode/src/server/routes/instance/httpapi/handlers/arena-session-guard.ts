import { ArenaRuntime } from "@/arena/runtime"
import { SessionID } from "@/session/schema"
import { Effect } from "effect"

export const assertSessionMutationAllowed = Effect.fn("ArenaHttpApi.assertSessionMutationAllowed")(function* (
  sessionID: SessionID,
) {
  if (!ArenaRuntime.enabled()) return
  const blocked = yield* Effect.tryPromise({
    try: () => ArenaRuntime.isUnresolvedContestantSession(sessionID),
    catch: () => new Error("Session is controlled by an unresolved Arena battle"),
  })
  if (blocked) return yield* Effect.fail(new Error("Session is controlled by an unresolved Arena battle"))
  const battleActive = yield* Effect.tryPromise({
    try: () => ArenaRuntime.isBattleActiveCanonicalSession(sessionID),
    catch: () => new Error("Session is controlled by an unresolved Arena battle"),
  })
  if (battleActive) return yield* Effect.fail(new Error("Session is controlled by an unresolved Arena battle"))
})

export const assertSessionForkAllowed = Effect.fn("ArenaHttpApi.assertSessionForkAllowed")(function* (
  sessionID: SessionID,
) {
  if (!ArenaRuntime.enabled()) return
  const blocked = yield* Effect.tryPromise({
    try: () => ArenaRuntime.isUnresolvedContestantSession(sessionID),
    catch: () => new Error("Session is controlled by an unresolved Arena battle"),
  })
  if (blocked) return yield* Effect.fail(new Error("Session is controlled by an unresolved Arena battle"))
})
