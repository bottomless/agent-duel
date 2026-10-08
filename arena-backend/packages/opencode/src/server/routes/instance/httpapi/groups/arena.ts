import { Schema } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Question } from "@/question"
import { ArenaActivity } from "@/arena/activity"
import { ArenaAttachments } from "@/arena/attachments"
import { ArenaSchema } from "@/arena/schema"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"

// Resolving or subscribing can create a chat. Both carry the account resolved
// by the daemon so the first watch also records its owner.
export const SessionQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  userID: Schema.optional(Schema.String),
})
export const SnapshotQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  afterSequence: Schema.optional(Schema.NumberFromString),
})
export const InspectFileQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
})
export const PromptPayload = Schema.Struct({
  prompt: Schema.String,
  participantID: Schema.optional(Schema.String),
  autoAccept: Schema.optional(Schema.Boolean),
  attachments: Schema.optional(Schema.Array(ArenaAttachments.Input)),
})
export const ReplyPayload = Schema.Struct({
  prompt: Schema.String,
  target: Schema.Literals(["a", "b", "both"]),
  attachments: Schema.optional(Schema.Array(ArenaAttachments.Input)),
})
// The review stream the app emits while a voter decides. Carries `side`, never
// a model: the client does not know which model it draws and must not learn it
// from its own telemetry.
const ReviewEventFields = {
  id: Schema.String,
  mountId: Schema.String,
  offsetMs: Schema.Number,
  clientAtMs: Schema.Number,
}
const ReviewEvent = Schema.Union([
  Schema.Struct({ ...ReviewEventFields, type: Schema.Literal("battle.opened") }),
  Schema.Struct({ ...ReviewEventFields, type: Schema.Literal("window.focus") }),
  Schema.Struct({ ...ReviewEventFields, type: Schema.Literal("window.blur") }),
  Schema.Struct({ ...ReviewEventFields, type: Schema.Literal("focus.toggled"), on: Schema.Boolean }),
  Schema.Struct({
    ...ReviewEventFields,
    type: Schema.Literal("tab.viewed"),
    tab: Schema.Literals(["verdict", "changes"]),
  }),
  Schema.Struct({ ...ReviewEventFields, type: Schema.Literal("verdict.expanded") }),
  Schema.Struct({ ...ReviewEventFields, type: Schema.Literal("verdict.folded") }),
  Schema.Struct({
    ...ReviewEventFields,
    type: Schema.Literal("file.selected"),
    file: Schema.String,
    index: Schema.Number,
  }),
  Schema.Struct({
    ...ReviewEventFields,
    type: Schema.Literal("diff.scrolled"),
    file: Schema.String,
    depth: Schema.Number,
  }),
  Schema.Struct({
    ...ReviewEventFields,
    type: Schema.Literal("layout.changed"),
    layout: Schema.Literals(["split", "single"]),
  }),
  Schema.Struct({
    ...ReviewEventFields,
    type: Schema.Literal("contestant.expanded"),
    side: Schema.Literals(["a", "b"]),
  }),
  Schema.Struct({ ...ReviewEventFields, type: Schema.Literal("activity.expanded"), side: Schema.Literals(["a", "b"]) }),
  Schema.Struct({ ...ReviewEventFields, type: Schema.Literal("vote.hovered"), side: Schema.Literals(["a", "b"]) }),
  Schema.Struct({ ...ReviewEventFields, type: Schema.Literal("preview.opened"), side: Schema.Literals(["a", "b"]) }),
]).annotate({ discriminator: "type", identifier: "ArenaReviewEvent" })

export const ReviewEventsPayload = Schema.Struct({
  events: Schema.Array(ReviewEvent),
  participantID: Schema.optional(Schema.String),
  // Resolved by the daemon from the socket, never sent by the browser.
  ipAddress: Schema.optional(Schema.String),
})
export const ReviewEventsResult = Schema.Struct({
  received: Schema.Number,
  accepted: Schema.Number,
})

export const VotePayload = Schema.Struct({
  vote: Schema.Literals(["a", "b", "tie"]),
  participantID: Schema.optional(Schema.String),
})
export const SingleAgentVotePayload = Schema.Struct({
  ratingID: Schema.String,
  vote: Schema.Literals(["up", "down"]),
  participantID: Schema.optional(Schema.String),
})
export const RetryResolutionPayload = Schema.Struct({
  /**
   * `discard_winner` drops the winner instead of applying it; `restore_workspace` puts back a
   * checkout an apply left half written. Absent for a retry or a review answer.
   */
  mode: Schema.optional(Schema.Literals(["discard_winner", "restore_workspace"])),
  /** Answers to a `review` application, matched to its items by key and fingerprint. */
  answers: Schema.optional(Schema.Array(ArenaSchema.ReviewAnswer)),
})
export const StopResolutionPayload = Schema.Struct({
  resolution: Schema.Literals(["discard", "apply_a", "apply_b"]),
})
export const PermissionReplyPayload = Schema.Struct({ response: PermissionV1.Reply })
export const SeedWorktreePayload = Schema.Struct({
  source: Schema.String,
  target: Schema.String,
})
export const SeedWorktreeResult = Schema.Struct({
  entries: Schema.Number,
  cloned: Schema.Number,
  copied: Schema.Number,
})
export const CheckoutCleanupPayload = Schema.Struct({ root: Schema.String })
export const CheckoutCleanupResult = Schema.Struct({
  eligible: Schema.Boolean,
  lastActivityAt: Schema.NullOr(Schema.String),
  reason: Schema.optional(Schema.String),
})
export const EnvironmentTrimPayload = Schema.Struct({
  keep: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  volumeOf: Schema.optional(Schema.String),
})
export const EnvironmentTrimResult = Schema.Struct({
  chats: Schema.Number,
  released: Schema.Number,
  kept: Schema.Number,
})
export const QuestionReplyPayload = Question.Reply
export const ForkSessionPayload = Schema.Struct({
  destination: Schema.String,
  messageID: Schema.optional(Schema.String),
})
export const ForkSessionResult = Schema.Struct({ sessionID: Schema.String })

export class ArenaApiError extends Schema.ErrorClass<ArenaApiError>("ArenaApiError")(
  {
    name: Schema.Literal("ArenaApiError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

const group = HttpApiGroup.make("arena")
  .add(
    HttpApiEndpoint.post("activity", "/arena/activity", {
      query: WorkspaceRoutingQuery,
      payload: Schema.Struct({ sessionIDs: Schema.Array(Schema.String) }),
      success: Schema.Array(ArenaActivity.Session),
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.activity",
        summary: "Read activity for existing Arena sessions",
        description: "Read blinded battle status in a batch without initializing chats or loading transcripts.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("stream", "/arena/sessions/:sessionID/stream", {
      params: { sessionID: Schema.String },
      query: Schema.Struct({ ...SessionQuery.fields, turnID: Schema.optional(Schema.String) }),
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
      error: ArenaApiError,
    }).annotateMerge(OpenApi.annotations({ identifier: "arena.stream", summary: "Subscribe to Arena updates" })),
  )
  .add(
    HttpApiEndpoint.get("session", "/arena/sessions/:sessionID", {
      params: { sessionID: Schema.String },
      query: SessionQuery,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.session",
        summary: "Resolve an Arena chat",
        description: "Resolve or initialize the Arena chat associated with an OpenCode session.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("singleAgentVote", "/arena/sessions/:sessionID/single-agent-vote", {
      params: { sessionID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: SingleAgentVotePayload,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.single_agent.vote",
        summary: "Rate and reveal a single Arena agent",
        description: "Record thumbs up or down separately from battle votes, then reveal the assigned contestant.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("archiveSession", "/arena/sessions/:sessionID/archive", {
      params: { sessionID: Schema.String },
      query: WorkspaceRoutingQuery,
      success: Schema.NullOr(ArenaSchema.Snapshot),
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.session.archive",
        summary: "Archive an Arena chat",
        description: "Release all Arena resources owned by a source session before its workspace is archived.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("forkSession", "/arena/sessions/:sessionID/fork", {
      params: { sessionID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: ForkSessionPayload,
      success: ForkSessionResult,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.session.fork",
        summary: "Fork a chat into another directory",
        description:
          "Copy a session through the selected message, move the copy into the destination, and point every path the copy names at the destination.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("snapshot", "/arena/chats/:chatID", {
      params: { chatID: Schema.String },
      query: SnapshotQuery,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.snapshot",
        summary: "Get Arena battle state",
        description: "Return the authoritative current or most recently resolved Arena battle snapshot.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("turn", "/arena/turns/:turnID", {
      params: { turnID: Schema.String },
      query: SnapshotQuery,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn",
        summary: "Inspect an Arena turn",
        description: "Return any active or historical turn, including both retained run timelines after resolution.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("diff", "/arena/turns/:turnID/diff", {
      params: { turnID: Schema.String },
      query: WorkspaceRoutingQuery,
      success: ArenaSchema.ComparisonDiff,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.diff",
        summary: "Compare Arena results",
        description: "Return the bounded deterministic Git diff from result A to result B.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("inspect", "/arena/chats/:chatID/turns/:turnID/inspect/:side", {
      params: {
        chatID: Schema.String,
        turnID: Schema.String,
        side: Schema.Literals(["a", "b"]),
      },
      query: WorkspaceRoutingQuery,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.inspect",
        summary: "Inspect one Arena result",
        description: "Return bounded live or finalized Git evidence for one contestant without mutating its worktree.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("inspectTree", "/arena/chats/:chatID/turns/:turnID/inspect/:side/tree", {
      params: {
        chatID: Schema.String,
        turnID: Schema.String,
        side: Schema.Literals(["a", "b"]),
      },
      query: WorkspaceRoutingQuery,
      success: ArenaSchema.InspectTree,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.inspect.tree",
        summary: "List one Arena result tree",
        description: "List a bounded read-only live worktree or retained finalized Git tree for one contestant.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("inspectFile", "/arena/chats/:chatID/turns/:turnID/inspect/:side/file", {
      params: {
        chatID: Schema.String,
        turnID: Schema.String,
        side: Schema.Literals(["a", "b"]),
      },
      query: InspectFileQuery,
      success: ArenaSchema.InspectFile,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.inspect.file",
        summary: "Read one Arena result file",
        description: "Read a bounded repository-relative file from a live worktree or retained finalized Git object.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("replyPermission", "/arena/runs/:runID/permissions/:requestID/reply", {
      params: { runID: Schema.String, requestID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: PermissionReplyPayload,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.run.permission.reply",
        summary: "Reply to a contestant permission",
        description: "Route a permission response to the correct isolated contestant instance.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("replyQuestion", "/arena/runs/:runID/questions/:requestID/reply", {
      params: { runID: Schema.String, requestID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: QuestionReplyPayload,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.run.question.reply",
        summary: "Answer a contestant question",
        description: "Route question answers to the correct isolated contestant instance.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("rejectQuestion", "/arena/runs/:runID/questions/:requestID/reject", {
      params: { runID: Schema.String, requestID: Schema.String },
      query: WorkspaceRoutingQuery,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.run.question.reject",
        summary: "Reject a contestant question",
        description: "Reject a pending question for one isolated contestant.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("setAutoAccept", "/arena/sessions/:sessionID/auto-accept", {
      params: { sessionID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: Schema.Null,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.session.auto_accept",
        summary: "Set automatic tool permission approval for an active battle",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("startTurn", "/arena/chats/:chatID/turns", {
      params: { chatID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: PromptPayload,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.start",
        summary: "Start an Arena battle",
        description: "Admit one prompt and start two distinct hidden contestants in parallel.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("reply", "/arena/turns/:turnID/reply", {
      params: { turnID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: ReplyPayload,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.reply",
        summary: "Reply to active Arena contestants",
        description: "Steer contestant A, contestant B, or both while their battle is running.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("vote", "/arena/turns/:turnID/vote", {
      params: { turnID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: VotePayload,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.vote",
        summary: "Choose an Arena result",
        description: "Commit an A, B, or tie vote and promote the selected result; ties apply A.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("recordReview", "/arena/turns/:turnID/review-events", {
      params: { turnID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: ReviewEventsPayload,
      success: ReviewEventsResult,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.recordReview",
        summary: "Record Arena review activity",
        description:
          "Append what a voter did while reviewing a battle. Idempotent on event id, so a replayed flush is safe.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("retryResolution", "/arena/turns/:turnID/retry-resolution", {
      params: { turnID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: RetryResolutionPayload,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.resolution.retry",
        summary: "Retry an Arena resolution",
        description:
          "Retry the recorded winner after Git application or session canonicalization was blocked. A review application carries the developer's answers; `discard_winner` drops the result instead.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("retryComparison", "/arena/turns/:turnID/retry-comparison", {
      params: { turnID: Schema.String },
      query: WorkspaceRoutingQuery,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.comparison.retry",
        summary: "Retry an Arena comparison",
        description: "Re-run the independent A/B comparison after the utility model failed to produce one.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("stop", "/arena/turns/:turnID/stop", {
      params: { turnID: Schema.String },
      query: WorkspaceRoutingQuery,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.stop",
        summary: "Stop both contestants",
        description: "Cancel both sides and retain their partial results for explicit resolution.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("resolveStop", "/arena/turns/:turnID/stop-resolution", {
      params: { turnID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: StopResolutionPayload,
      success: ArenaSchema.Snapshot,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.turn.stop.resolve",
        summary: "Resolve a stopped battle",
        description: "Discard a stopped turn or promote the partial A or B result outside benchmark scoring.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("inspectCheckout", "/arena/checkout/inspect", {
      query: WorkspaceRoutingQuery,
      payload: CheckoutCleanupPayload,
      success: CheckoutCleanupResult,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "arena.checkout.inspect", summary: "Inspect Arena checkout eviction" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("prepareCheckout", "/arena/checkout/prepare", {
      query: WorkspaceRoutingQuery,
      payload: CheckoutCleanupPayload,
      success: HttpApiSchema.NoContent,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "arena.checkout.prepare", summary: "Prepare Arena checkout eviction" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("releaseCheckout", "/arena/checkout/release", {
      query: WorkspaceRoutingQuery,
      payload: CheckoutCleanupPayload,
      success: HttpApiSchema.NoContent,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "arena.checkout.release", summary: "Release Arena checkout eviction" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("trimEnvironments", "/arena/environments/trim", {
      query: WorkspaceRoutingQuery,
      payload: EnvironmentTrimPayload,
      success: EnvironmentTrimResult,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.environments.trim",
        summary: "Release idle chats' contestant worktrees",
        description:
          "Keep contestant worktrees for the chats with the latest battle activity and release the others' while they are idle. Covers every chat, whichever directory routes the request, or with `volumeOf` only the chats whose worktrees are on that path's volume.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("seedWorktree", "/arena/worktrees/seed", {
      query: WorkspaceRoutingQuery,
      payload: SeedWorktreePayload,
      success: SeedWorktreeResult,
      error: ArenaApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "arena.worktree.seed",
        summary: "Seed a worktree with a checkout's ignored content",
        description:
          "Clone everything the source checkout ignores into a freshly created worktree, the way a contestant is seeded, so its setup command starts from a warm dependency tree.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "Arena", description: "Blind A/B coding-agent prototype routes." }))
  .middleware(InstanceContextMiddleware)
  .middleware(WorkspaceRoutingMiddleware)
  .middleware(Authorization)

export const ArenaApi = HttpApi.make("arena").add(group)
