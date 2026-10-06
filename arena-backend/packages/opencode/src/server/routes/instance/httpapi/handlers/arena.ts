import { Effect, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiSchema } from "effect/unstable/httpapi"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { seedWorktreeIgnoredContent } from "@/arena/copy-snapshot"
import { forkSessionInto } from "@/arena/fork"
import { ArenaService } from "@/arena/service"
import { MessageID, SessionID } from "@/session/schema"
import { InstanceHttpApi } from "../api"
import { ArenaApiError, type ForkSessionPayload } from "../groups/arena"
import { assertSessionForkAllowed } from "./arena-session-guard"

function map<A, R>(effect: Effect.Effect<A, Error, R>) {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new ArenaApiError({
          name: "ArenaApiError",
          data: { message: error.message },
        }),
    ),
  )
}

const forkSession = Effect.fn("ArenaHttpApi.forkSession")(function* (ctx: {
  params: { sessionID: string }
  payload: typeof ForkSessionPayload.Type
}) {
  const sessionID = SessionID.make(ctx.params.sessionID)
  yield* assertSessionForkAllowed(sessionID).pipe(
    Effect.mapError(() => new Error("An unresolved contestant session cannot be forked")),
  )
  const forked = yield* forkSessionInto({
    sessionID,
    destination: ctx.payload.destination,
    ...(ctx.payload.messageID ? { messageID: MessageID.make(ctx.payload.messageID) } : {}),
  }).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))))
  return { sessionID: forked.id }
})

export const arenaHandlers = HttpApiBuilder.group(InstanceHttpApi, "arena", (handlers) =>
  Effect.gen(function* () {
    const arena = yield* ArenaService.Service
    return handlers
      .handle("activity", (ctx) => map(arena.activity(ctx.payload.sessionIDs)))
      .handleRaw("stream", (ctx) =>
        map(arena.stream(ctx.params.sessionID, ctx.query.turnID, ctx.query.userID)).pipe(
          Effect.map((stream) =>
            HttpServerResponse.stream(
              stream.pipe(
                Stream.map((frame) => ({
                  _tag: "Event" as const,
                  event: "message",
                  id: undefined,
                  data: JSON.stringify(frame),
                })),
                Stream.pipeThroughChannel(Sse.encode()),
                Stream.encodeText,
              ),
              {
                contentType: "text/event-stream",
                headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
              },
            ),
          ),
        ),
      )
      .handle("session", (ctx) => map(arena.session(ctx.params.sessionID, ctx.query.userID)))
      .handle("singleAgentVote", (ctx) =>
        map(
          arena.singleAgentVote(
            ctx.params.sessionID,
            ctx.payload.ratingID,
            ctx.payload.vote,
            ctx.payload.participantID,
          ),
        ),
      )
      .handle("archiveSession", (ctx) => map(arena.archiveSession(ctx.params.sessionID)))
      .handle("forkSession", (ctx) => map(forkSession(ctx)))
      .handle("snapshot", (ctx) => map(arena.snapshot(ctx.params.chatID, ctx.query.afterSequence)))
      .handle("turn", (ctx) => map(arena.turn(ctx.params.turnID, ctx.query.afterSequence)))
      .handle("diff", (ctx) => map(arena.diff(ctx.params.turnID)))
      .handle("inspect", (ctx) => map(arena.inspect(ctx.params.chatID, ctx.params.turnID, ctx.params.side)))
      .handle("inspectTree", (ctx) => map(arena.inspectTree(ctx.params.chatID, ctx.params.turnID, ctx.params.side)))
      .handle("inspectFile", (ctx) =>
        map(arena.inspectFile(ctx.params.chatID, ctx.params.turnID, ctx.params.side, ctx.query.path)),
      )
      .handle("replyPermission", (ctx) =>
        map(arena.replyPermission(ctx.params.runID, ctx.params.requestID, ctx.payload.response)),
      )
      .handle("replyQuestion", (ctx) =>
        map(arena.replyQuestion(ctx.params.runID, ctx.params.requestID, ctx.payload.answers)),
      )
      .handle("rejectQuestion", (ctx) => map(arena.rejectQuestion(ctx.params.runID, ctx.params.requestID)))
      .handle("startTurn", (ctx) =>
        map(
          arena.startTurn(
            ctx.params.chatID,
            ctx.payload.prompt,
            ctx.payload.participantID,
            ctx.payload.autoAccept,
            ctx.payload.attachments,
          ),
        ),
      )
      .handle("setAutoAccept", (ctx) =>
        map(arena.setAutoAccept(ctx.params.sessionID, ctx.payload.enabled).pipe(Effect.as(null))),
      )
      .handle("reply", (ctx) =>
        map(arena.reply(ctx.params.turnID, ctx.payload.prompt, ctx.payload.target, ctx.payload.attachments)),
      )
      .handle("vote", (ctx) => map(arena.vote(ctx.params.turnID, ctx.payload.vote, ctx.payload.participantID)))
      .handle("recordReview", (ctx) =>
        map(
          arena.recordReview(ctx.params.turnID, ctx.payload.events, ctx.payload.participantID, ctx.payload.ipAddress),
        ),
      )
      .handle("retryResolution", (ctx) => map(arena.retryResolution(ctx.params.turnID, ctx.payload.mode, ctx.payload.answers)))
      .handle("retryComparison", (ctx) => map(arena.retryComparison(ctx.params.turnID)))
      .handle("stop", (ctx) => map(arena.stop(ctx.params.turnID)))
      .handle("resolveStop", (ctx) => map(arena.resolveStop(ctx.params.turnID, ctx.payload.resolution)))
      .handle("inspectCheckout", (ctx) => map(arena.inspectCheckout(ctx.payload.root)))
      .handle("prepareCheckout", (ctx) =>
        map(arena.prepareCheckout(ctx.payload.root).pipe(Effect.as(HttpApiSchema.NoContent.make()))),
      )
      .handle("releaseCheckout", (ctx) =>
        map(arena.releaseCheckout(ctx.payload.root).pipe(Effect.as(HttpApiSchema.NoContent.make()))),
      )
      .handle("seedWorktree", (ctx) =>
        map(
          Effect.tryPromise({
            try: () => seedWorktreeIgnoredContent({ source: ctx.payload.source, target: ctx.payload.target }),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }),
        ),
      )
  }),
)
