import { ArenaRuntime } from "@/arena/runtime"
import { SessionID } from "@/session/schema"
import { Effect } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"

export const assertSessionMutationAllowed = Effect.fn("ArenaHttpApi.assertSessionMutationAllowed")(function* (
  sessionID: SessionID,
) {
  if (!ArenaRuntime.enabled()) return
  const blocked = yield* Effect.tryPromise({
    try: () => ArenaRuntime.isUnresolvedContestantSession(sessionID),
    catch: () => new HttpApiError.BadRequest({}),
  })
  if (blocked) return yield* new HttpApiError.BadRequest({})
  const battleActive = yield* Effect.tryPromise({
    try: () => ArenaRuntime.isBattleActiveCanonicalSession(sessionID),
    catch: () => new HttpApiError.BadRequest({}),
  })
  if (battleActive) return yield* new HttpApiError.BadRequest({})
})

export const assertSessionForkAllowed = Effect.fn("ArenaHttpApi.assertSessionForkAllowed")(function* (
  sessionID: SessionID,
) {
  if (!ArenaRuntime.enabled()) return
  const blocked = yield* Effect.tryPromise({
    try: () => ArenaRuntime.isUnresolvedContestantSession(sessionID),
    catch: () => new HttpApiError.BadRequest({}),
  })
  if (blocked) return yield* new HttpApiError.BadRequest({})
})
