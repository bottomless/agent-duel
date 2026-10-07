import { Schema } from "effect"
import { BattleState, Side, StopResolution, Vote } from "./domain"
import { ArenaActiveOperation } from "./operation-tracker"

const Identity = Schema.Struct({ name: Schema.String })
const Identities = Schema.Struct({ a: Identity, b: Identity })
const DiffSummary = Schema.Struct({
  files: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
})

// Public projections intentionally keep copy metadata to the relative path and
// reason. Source identities, sizes, and contents stay in durable records only.
const CopyOmission = Schema.Struct({
  relativePath: Schema.String,
  omissionReason: Schema.optional(Schema.String),
})

const Service = Schema.Struct({
  kind: Schema.Literal("owned_process"),
  command: Schema.String,
  relativeCwd: Schema.String,
  listeners: Schema.Array(
    Schema.Struct({
      port: Schema.Number,
      alias: Schema.optional(Schema.String),
    }),
  ),
  proxyRoutes: Schema.Array(
    Schema.Struct({
      hostname: Schema.String,
      url: Schema.optional(Schema.String),
      port: Schema.optional(Schema.Number),
      alias: Schema.optional(Schema.String),
      active: Schema.Boolean,
    }),
  ),
})

const CurrentEnvironment = Schema.Struct({
  retainedWinner: Schema.optional(
    Schema.Struct({
      runID: Schema.String,
      side: Schema.Literals(Side),
      worktreeName: Schema.String,
      branch: Schema.optional(Schema.String),
      state: Schema.Literals(["live", "stopping", "cleanup_failed"]),
    }),
  ),
  warmPair: Schema.optional(
    Schema.Struct({
      generation: Schema.Number,
      state: Schema.Literals(["pending", "ready", "failed"]),
      sides: Schema.Array(
        Schema.Struct({
          side: Schema.Literals(Side),
          worktreeName: Schema.String,
          branch: Schema.optional(Schema.String),
          ready: Schema.Boolean,
        }),
      ),
      error: Schema.optional(Schema.String),
    }),
  ),
})

const TransitionStoppedCommand = Schema.Struct({
  command: Schema.String,
  relativeCwd: Schema.String,
  status: Schema.Literals(["stopped", "already_absent", "failed"]),
  verified: Schema.Boolean,
  listeners: Schema.optional(
    Schema.Array(
      Schema.Struct({
        alias: Schema.optional(Schema.String),
      }),
    ),
  ),
  error: Schema.optional(Schema.String),
})

const TransitionSummary = Schema.Struct({
  commandsStopped: Schema.Number,
  commandsAlreadyAbsent: Schema.Number,
  stopFailures: Schema.Number,
  listenersReleased: Schema.Number,
  pathsOmitted: Schema.Number,
})

const EnvironmentTransition = Schema.Struct({
  id: Schema.String,
  previousWinningRunID: Schema.String,
  stoppedCommands: Schema.Array(TransitionStoppedCommand),
  copyOmissions: Schema.Array(CopyOmission),
  summary: Schema.optional(TransitionSummary),
  createdAt: Schema.String,
})

const RefOutcome = Schema.Struct({
  ref: Schema.String,
  action: Schema.Literals(["created", "updated", "deleted", "skipped"]),
  reason: Schema.optional(Schema.String),
  backupRef: Schema.optional(Schema.String),
  removed: Schema.optional(Schema.Number),
  how: Schema.optional(Schema.Literals(["agent_on_yours", "yours_on_agent"])),
})

const BranchAction = ["agent", "yours", "agent_on_yours", "yours_on_agent", "combine"] as const
const AgentMove = ["created", "added", "rewrote", "deleted"] as const
const YourMove = ["untouched", "created", "added", "rewrote", "deleted"] as const

const ReviewItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ref"),
    key: Schema.String,
    fingerprint: Schema.String,
    namespace: Schema.Literals(["branch", "tag", "remote"]),
    agentMove: Schema.Literals(AgentMove),
    yourMove: Schema.Literals(YourMove),
    proposal: Schema.Literals([...BranchAction, "ask_agent"]),
    choices: Schema.Array(Schema.Literals(BranchAction)),
    checkout: Schema.Boolean,
    checkedOutAt: Schema.optional(Schema.String),
    clash: Schema.optional(Schema.Array(Schema.String)),
    agentRef: Schema.optional(Schema.String),
    lost: Schema.optional(Schema.Number),
    lostSubjects: Schema.optional(Schema.Array(Schema.String)),
    rewound: Schema.optional(Schema.Boolean),
    agentSubject: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("edits"),
    key: Schema.Literal("@edits"),
    fingerprint: Schema.String,
    paths: Schema.Array(Schema.String),
    unmergeable: Schema.Array(Schema.String),
    choices: Schema.Array(Schema.Literals(["combine", "agent", "yours"])),
  }),
  Schema.Struct({
    kind: Schema.Literal("occupied"),
    key: Schema.Literal("@occupied"),
    fingerprint: Schema.String,
    branch: Schema.String,
    path: Schema.String,
    proposal: Schema.Literals(["take", "stay"]),
    choices: Schema.Array(Schema.Literals(["take", "stay"])),
  }),
  Schema.Struct({
    kind: Schema.Literal("busy"),
    key: Schema.Literal("@busy"),
    fingerprint: Schema.String,
    operation: Schema.String,
  }),
])

export const ReviewAnswer = Schema.Struct({
  key: Schema.String,
  fingerprint: Schema.String,
  choice: Schema.Literals([...BranchAction, "take", "stay"]),
})

const GitApplication = Schema.Struct({
  // `review` is the one state that reports work not yet done: the promotion stopped before
  // writing anything, and `review.items` are the questions it needs answered first.
  state: Schema.Literals([
    "pending",
    "applied",
    "blocked",
    "failed",
    "conflicted",
    "manual",
    "review",
    "discarded",
  ]),
  reason: Schema.optional(Schema.String),
  resultCommit: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  baseCommit: Schema.optional(Schema.String),
  conflicts: Schema.optional(Schema.Array(Schema.String)),
  review: Schema.optional(
    Schema.Struct({
      items: Schema.Array(ReviewItem),
      planned: Schema.Array(Schema.Struct({ ref: Schema.String, action: Schema.Literals(BranchAction) })),
      switchTo: Schema.optional(Schema.String),
    }),
  ),
  partial: Schema.optional(
    Schema.Struct({
      expectedBranch: Schema.optional(Schema.String),
      expectedDetached: Schema.optional(Schema.Boolean),
      targetBranch: Schema.optional(Schema.String),
    }),
  ),
  discardedRef: Schema.optional(Schema.String),
  refs: Schema.optional(Schema.Array(RefOutcome)),
  /** The branch the vote moved this workspace to, when it is not the one the battle started on. */
  switchedTo: Schema.optional(Schema.String),
})

const Resolution = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("vote"), vote: Schema.Literals(Vote), appliedSide: Schema.Literals(Side) }),
  Schema.Struct({
    kind: Schema.Literal("stopped"),
    resolution: Schema.Literals(StopResolution),
    appliedSide: Schema.optional(Schema.Literals(Side)),
  }),
  Schema.Struct({ kind: Schema.Literal("early"), vote: Schema.Literals(Side), appliedSide: Schema.Literals(Side) }),
  Schema.Struct({ kind: Schema.Literal("aborted"), reason: Schema.String }),
])

const HistoryItem = Schema.Struct({
  id: Schema.String,
  index: Schema.Number,
  state: Schema.Literals(BattleState),
  resolution: Schema.optional(Resolution),
  vote: Schema.optional(Schema.Literals(Vote)),
  selectedEarly: Schema.optional(Schema.Boolean),
  appliedSide: Schema.optional(Schema.Literals(Side)),
  canonicalUserMessageID: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  identities: Schema.optional(Identities),
  gitApplication: Schema.optional(GitApplication),
  transition: Schema.optional(EnvironmentTransition),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})

const ActiveOperations = Schema.Array(Schema.Literals(ArenaActiveOperation))
const OperationProgress = Schema.Union([
  Schema.Struct({
    operation: Schema.Literals(ArenaActiveOperation),
    startedAt: Schema.Number,
    state: Schema.Literal("running"),
  }),
  Schema.Struct({
    operation: Schema.Literals(ArenaActiveOperation),
    startedAt: Schema.Number,
    finishedAt: Schema.Number,
    state: Schema.Literals(["completed", "failed", "interrupted"]),
  }),
])

const Inspection = Schema.Struct({
  status: Schema.String,
  patch: Schema.String,
  patchTruncated: Schema.Boolean,
  finalRef: Schema.optional(Schema.String),
  finalCommit: Schema.optional(Schema.String),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      status: Schema.optional(Schema.String),
      additions: Schema.optional(Schema.Number),
      deletions: Schema.optional(Schema.Number),
      binary: Schema.optional(Schema.Boolean),
    }),
  ),
  commands: Schema.Array(Schema.Struct({ command: Schema.String })),
  commandsTruncated: Schema.Boolean,
})

const PublicRun = Schema.Struct({
  id: Schema.String,
  side: Schema.Literals(Side),
  sessionID: Schema.String,
  descendantSessionIDs: Schema.Array(Schema.String),
  worktree: Schema.String,
  worktreeName: Schema.String,
  branchAtRun: Schema.optional(Schema.String),
  worktreeActive: Schema.Boolean,
  copyOmissions: Schema.optional(Schema.Array(CopyOmission)),
  portAliases: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  services: Schema.optional(Schema.Array(Service)),
  retention: Schema.optional(Schema.Literals(["none", "retained_until_next_send", "cleanup_failed"])),
  runState: Schema.Literals(["pending", "complete", "stopped", "error", "interrupted"]),
  error: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  firstEventAt: Schema.optional(Schema.String),
  lastEventAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  durationMs: Schema.NullOr(Schema.Number),
  promptMessageID: Schema.optional(Schema.String),
  diff: Schema.optional(DiffSummary),
  finalCommit: Schema.optional(Schema.String),
  finalTree: Schema.optional(Schema.String),
  permanentRef: Schema.optional(Schema.String),
  selectable: Schema.Boolean,
  applicable: Schema.Boolean,
  identity: Schema.optional(Identity),
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
  parts: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.Unknown))),
  status: Schema.optional(Schema.Unknown),
  permissions: Schema.optional(Schema.Array(Schema.Unknown)),
  questions: Schema.optional(Schema.Array(Schema.Unknown)),
  inspection: Schema.optional(Inspection),
})

export const Snapshot = Schema.Struct({
  chat: Schema.Struct({
    id: Schema.String,
    status: Schema.Literals(["ready", "battle_active", "blocked", "failed", "archived"]),
    canonicalSessionID: Schema.String,
    canonicalSHA: Schema.String,
    activeTurnID: Schema.optional(Schema.String),
    blockedReason: Schema.optional(Schema.String),
    trunkConflicts: Schema.optional(Schema.Array(Schema.String)),
    trunk: Schema.Struct({
      worktreeName: Schema.String,
      branch: Schema.optional(Schema.String),
    }),
  }),
  environment: CurrentEnvironment,
  singleAgent: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      revealed: Schema.Boolean,
      vote: Schema.optional(Schema.Literals(["up", "down"])),
      identity: Schema.optional(Identity),
    }),
  ),
  turn: Schema.optional(
    Schema.Struct({
      ...HistoryItem.fields,
      prompt: Schema.String,
      attachments: Schema.optional(
        Schema.Array(Schema.Struct({ kind: Schema.Literals(["image", "text", "file"]), label: Schema.String })),
      ),
      baseSHA: Schema.String,
      comparisonState: Schema.Literals(["pending", "running", "complete", "skipped", "failed"]),
      activeOperations: Schema.optional(ActiveOperations),
      operationProgress: Schema.optional(Schema.Array(OperationProgress)),
      canVote: Schema.Boolean,
      canRetryResolution: Schema.Boolean,
      canDiscardWinner: Schema.Boolean,
      revealed: Schema.Boolean,
    }),
  ),
  history: Schema.Array(HistoryItem),
  runs: Schema.Array(PublicRun),
  events: Schema.Array(Schema.Unknown),
  comparison: Schema.optional(
    Schema.Struct({
      state: Schema.Literals(["pending", "running", "complete", "failed"]),
      output: Schema.optional(Schema.String),
      truncated: Schema.Boolean,
      omittedArtifacts: Schema.Array(Schema.String),
    }),
  ),
})

const Revision = Schema.Struct({ commit: Schema.String, ref: Schema.optional(Schema.String) })

const DiffStat = Schema.Struct({
  file: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  binary: Schema.Boolean,
})

// Absent regions mean content is the whole file. Present, they say where each retained
// run starts in that side's file, in order, so the viewer can number lines correctly and
// say what sits between them.
const FileRegion = Schema.Struct({
  start: Schema.Number,
  lines: Schema.Number,
})

const FileContent = Schema.Struct({
  content: Schema.String,
  truncated: Schema.Boolean,
  missing: Schema.Boolean,
  regions: Schema.optional(Schema.Array(FileRegion)),
  lines: Schema.optional(Schema.Number),
})

// One row per file touched by either contestant, carrying its content at base, A,
// and B so the UI can render a three-way comparison (Agent A / base / Agent B)
// instead of an A -> B delta that mixes both sides' edits into one confusing patch.
const ThreeWayFile = Schema.Struct({
  file: Schema.String,
  binary: Schema.Boolean,
  additionsA: Schema.Number,
  deletionsA: Schema.Number,
  additionsB: Schema.Number,
  deletionsB: Schema.Number,
  base: Schema.optional(FileContent),
  a: Schema.optional(FileContent),
  b: Schema.optional(FileContent),
})

// git's three-way merge of A and B over the base, per file. `merged` is the file as
// merge-tree wrote it, conflicts left as zdiff3 blocks; sent only for compatible and
// diverging files small enough to ship whole.
const DivergenceFile = Schema.Struct({
  file: Schema.String,
  status: Schema.Literals(["identical", "only_a", "only_b", "compatible", "diverging", "binary"]),
  merged: Schema.optional(FileContent),
})

const Divergence = Schema.Struct({
  mergeTree: Schema.String,
  conflicted: Schema.Boolean,
  files: Schema.Array(DivergenceFile),
})

export const ComparisonDiff = Schema.Struct({
  turnID: Schema.String,
  baseCommit: Schema.String,
  a: Schema.Struct({ commit: Schema.String, tree: Schema.String, ref: Schema.optional(Schema.String) }),
  b: Schema.Struct({ commit: Schema.String, tree: Schema.String, ref: Schema.optional(Schema.String) }),
  treesEqual: Schema.Boolean,
  files: Schema.Array(ThreeWayFile),
  filesTruncated: Schema.Boolean,
  patch: Schema.String,
  truncated: Schema.Boolean,
  stats: Schema.Array(DiffStat),
  divergence: Divergence,
})

export const InspectTree = Schema.Struct({
  chatID: Schema.String,
  turnID: Schema.String,
  side: Schema.Literals(Side),
  source: Schema.Literals(["live", "finalized"]),
  revision: Schema.optional(Revision),
  entries: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      type: Schema.Literals(["file", "directory", "symlink", "submodule", "other"]),
      size: Schema.optional(Schema.Number),
      mode: Schema.optional(Schema.String),
      objectID: Schema.optional(Schema.String),
    }),
  ),
  entryCount: Schema.Number,
  outputBytes: Schema.Number,
  truncated: Schema.Boolean,
  limits: Schema.Struct({ maxEntries: Schema.Number, maxOutputBytes: Schema.Number }),
})

export const InspectFile = Schema.Struct({
  chatID: Schema.String,
  turnID: Schema.String,
  side: Schema.Literals(Side),
  source: Schema.Literals(["live", "finalized"]),
  revision: Schema.optional(Revision),
  path: Schema.String,
  type: Schema.Literals(["file", "symlink"]),
  size: Schema.Number,
  returnedBytes: Schema.Number,
  truncated: Schema.Boolean,
  binary: Schema.Boolean,
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
  hash: Schema.Struct({
    algorithm: Schema.Literal("sha256"),
    value: Schema.String,
    scope: Schema.Literals(["full_content", "returned_prefix"]),
  }),
  mode: Schema.optional(Schema.String),
  objectID: Schema.optional(Schema.String),
  limitBytes: Schema.Number,
})

export type Snapshot = typeof Snapshot.Type
export type ComparisonDiff = typeof ComparisonDiff.Type
export type InspectTree = typeof InspectTree.Type
export type InspectFile = typeof InspectFile.Type

export * as ArenaSchema from "./schema"
