import type { BattleState, Resolution, Side, Vote } from "./domain"
import type { ArenaActiveOperation, ArenaOperationProgress } from "./operation-tracker"
import type { RefChange, RefOutcome } from "./ref-types"
import type { GenerationMetrics, UsageTotals } from "@agent-duel/arena-service/metrics"
import type { PlannedRef, ReviewAnswer, ReviewItem } from "./branch-review"

export type { GenerationMetrics, UsageTotals }

export type Identifier = string

export type ArenaPortAlias = "PASEO_PORT" | "PASEO_PORT2" | "PASEO_PORT3"

export type CopyOmissionReason =
  | "git_admin"
  | "special_file"
  | "ignored_file_too_large"
  | "ignored_total_limit"
  | "changed_during_snapshot"
  | "nested_worktree"
  | "excluded"
  | "outside_root"
  | "copy_failed"

export type ArenaCopyMethod = "clonefile" | "reflink" | "copy" | "directory" | "symlink" | "git" | "omitted"

export type CopyManifestEntry = {
  readonly relativePath: string
  readonly fileType: "file" | "directory" | "symlink" | "submodule" | "nested_worktree" | "special"
  readonly logicalBytes: number
  readonly physicalBytes: number
  readonly copyMethod: ArenaCopyMethod
  readonly sourceIdentity: string
  readonly state: "copied" | "omitted"
  readonly omissionReason?: CopyOmissionReason
}

export type CopyOmission = Pick<
  CopyManifestEntry,
  "relativePath" | "fileType" | "logicalBytes" | "sourceIdentity" | "omissionReason"
>

export type ResolvedArenaCopyPolicy = {
  readonly ignoredFileMaxBytes: number
  readonly ignoredTotalMaxBytes: number
  readonly exclude: readonly string[]
}

export type CapturedService = {
  readonly kind: "environment" | "owned_process"
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly relativeCwd: string
  readonly processGroupID?: number
  readonly managedTerminalID?: string
  readonly ownerID?: string
  readonly processStartIdentity?: string
  readonly listeners: readonly {
    readonly port: number
    readonly alias?: ArenaPortAlias
    readonly verifiedAt: Date
  }[]
  readonly proxyRoutes: readonly {
    readonly hostname: string
    readonly url?: string
    readonly port?: number
    readonly alias?: ArenaPortAlias
    readonly active: boolean
  }[]
  readonly capturedAt: Date
  readonly verifiedAt: Date
}

export type TransitionStoppedCommand = {
  readonly command: string
  readonly relativeCwd: string
  readonly status: "stopped" | "already_absent" | "failed"
  readonly verified: boolean
  /** Historical aliases only. Listener ports are intentionally not durable transition data. */
  readonly listeners?: readonly {
    readonly alias?: string
  }[]
  readonly error?: string
}

export type EnvironmentTransition = {
  readonly id: Identifier
  readonly previousWinningRunID: Identifier
  readonly stoppedCommands: readonly TransitionStoppedCommand[]
  readonly copyOmissions: readonly CopyOmission[]
  readonly createdAt: Date
  readonly summary?: {
    readonly commandsStopped: number
    readonly commandsAlreadyAbsent: number
    readonly stopFailures: number
    readonly listenersReleased?: number
    readonly pathsOmitted: number
  }
}

export type WarmWorktreeRecord = {
  readonly side: Side
  readonly name: string
  readonly directory: string
  readonly branch?: string
  readonly sourceHead?: string
  readonly sourceCommit: string
  readonly sourceIndexTree?: string
  readonly sourceWorkingTree?: string
  readonly copyManifestID: Identifier
  /** Hash of the copied manifest paths after worktree setup completed. */
  readonly contentFingerprint?: string
  readonly ready: boolean
  /** The host went through a full ref mirror at warm-up, so the send fetches only moved refs. */
  readonly refsMirrored?: boolean
  /**
   * The canonical session forked into this worktree at warm-up, with the transcript hash and
   * source it was copied from and the port bank its paths were localized against. A send uses
   * it only when all three still match and the pair is trusted in this process; otherwise it
   * forks again and disposes of this one.
   */
  readonly forkedSessionID?: string
  readonly forkSourceSessionID?: string
  readonly forkTranscriptHash?: string
  readonly forkMessageMap?: Readonly<Record<string, string>>
  readonly portAliases?: Readonly<Record<ArenaPortAlias, number>>
  /** How this worktree was last brought to its base, and where that time went. */
  readonly sync?: SlotSyncTimings
}

/**
 * A generation's warm pair: the two worktrees prepared for the turn with that index before it is
 * sent. The turn before it holds the record; generation 0 has none, so its chat does.
 */
export type WarmPreparation = {
  readonly generation: number
  state: "pending" | "ready" | "failed"
  readonly worktrees: Partial<Record<Side, WarmWorktreeRecord>>
  error?: string
}

/**
 * How one contestant worktree reached a turn's frozen base, in milliseconds. `reused` touched
 * nothing; `refreshed` re-synced a warm worktree in place at the send; `adopted` took a worktree an
 * earlier turn used; `created` checked one out from nothing. The counts are ignored roots.
 */
export type SlotSyncTimings = {
  readonly syncPath: "reused" | "refreshed" | "adopted" | "created"
  readonly syncMs: number
  /** Moving the worktree in and giving it a fresh host, or claiming a new one. */
  readonly adoptMs?: number
  readonly gitMs?: number
  readonly ignoredMs?: number
  readonly verifyMs?: number
  readonly recloned?: number
  readonly kept?: number
  /** Directory roots kept in place with only the paths written under them brought over, and those paths. */
  readonly patched?: number
  readonly patchedPaths?: number
  readonly discarded?: number
  /** Tracked files the kept index could not vouch for, so git wrote them again. */
  readonly distrusted?: number
  /** Every tracked file was written again: no index to trust, or what shapes their bytes changed. */
  readonly rewroteAll?: boolean
}

/**
 * Where a send spent its time, in milliseconds. Written with the turn record for the part
 * before it existed, and completed once both worktrees are ready. Read this before guessing
 * why a send felt slow.
 */
export type TurnSetupTimings = {
  /** From the send reaching the engine to the turn record being written. */
  readonly preCreationMs: number
  /** Time the send waited for the chat's start lock (warm preparation) before `preCreationMs` began. */
  readonly admissionWaitMs?: number
  readonly freezeMs: number
  readonly warmPath: "reused" | "refreshed" | "cold"
  readonly warmMs: number
  /** Time blocked on the assignment draw; zero when it had already answered. */
  readonly assignmentWaitMs: number
  readonly sides?: Partial<
    Record<
      Side,
      { totalMs: number; prepareMs: number; forkMs: number; forkedAtWarmup: boolean } & Partial<SlotSyncTimings>
    >
  >
  /** From the turn record to both sides ready. */
  readonly setupMs?: number
}

export type ConfigurationHashes = {
  readonly modelPool: string
  readonly agent: string
  readonly plugins: string
  readonly mcp: string
  readonly skills: string
  readonly tools: string
  readonly system: string
}

export type ChatDocument = {
  readonly _id: Identifier
  /**
   * The account that owns this chat and, transitively, every turn, run,
   * generation, event, artifact and comparison beneath it. Absent on documents
   * written before accounts existed, and on a backend running without them.
   */
  userId?: string
  readonly source?: {
    readonly root: string
    readonly branch?: string
  }
  readonly repository: {
    readonly projectID: string
    readonly root: string
    readonly branch?: string
  }
  readonly arenaBranch?: string
  readonly canonicalCheckout?: {
    readonly root: string
    readonly commonGitDir: string
    readonly branch?: string
    readonly detached: boolean
    readonly head: string
    readonly indexTree?: string
    readonly transcriptHash: string
  }
  retainedWinner?: {
    readonly runID: Identifier
    readonly worktree: string
    readonly resultRef: string
    state: "live" | "stopping" | "cleanup_failed"
  }
  warmGeneration?: number
  /**
   * The first battle's warm pair, prepared when the chat is opened, since no turn exists yet to
   * hold it. The first send copies it onto its turn, as later sends copy theirs, and clears it.
   */
  initialWarmPreparation?: WarmPreparation
  readonly initialCanonicalSHA: string
  currentCanonicalSHA: string
  canonicalSessionID: string
  canonicalTranscriptVersion: number
  canonicalTranscriptHash: string
  turnCount: number
  activeTurnID?: Identifier
  status: "ready" | "battle_active" | "blocked" | "failed" | "archived"
  blockedReason?: string
  /** Set while the daemon is evicting this checkout; cleared after restore. */
  checkoutEvicted?: boolean
  lastChatActivityAt?: Date
  // Repo-relative unmerged paths in the trunk checkout, as Git lists them. Present only while the
  // trunk holds unresolved merge conflicts. The chat stays ready; only a battle start is refused.
  readonly trunkConflicts?: readonly string[]
  readonly opencodeCommit: string
  readonly opencodeVersion: string
  readonly arenaVersion: string
  readonly configuration: ConfigurationHashes
  readonly utilityPromptVersion: string
  readonly createdAt: Date
  updatedAt: Date
}

/** Durable claim covering a checkout even when no Arena chat exists yet. */
export type CheckoutEvictionDocument = {
  readonly _id: string
  readonly root: string
  readonly createdAt: Date
  updatedAt: Date
}

export type HiddenAssignment = {
  readonly assignmentID: string
  model?: string
  readonly requestedReasoning: Readonly<Record<string, unknown>>
  readonly enforcedReasoning: Readonly<Record<string, unknown>>
}

export type SingleAgentVote = "up" | "down"

export type SingleAgentRatingDocument = {
  readonly _id: Identifier
  /**
   * Owned directly rather than through the chat: a rating is keyed by the
   * OpenCode session, and a chat's `canonicalSessionID` moves to the winning
   * run's session on every resolved battle. Adopted from the chat when one
   * already exists, and backfilled when the chat is created afterwards.
   */
  userId?: string
  readonly sessionID: string
  readonly messageID: string
  readonly assignment: HiddenAssignment
  completedAt?: Date
  precedingTurnCount?: number
  resultTree?: string
  vote?: SingleAgentVote
  voteParticipantID?: string
  voteAt?: Date
  revealAt?: Date
  readonly createdAt: Date
  updatedAt: Date
}

/** Drop the winner's result instead of applying it. The only answer that ends a review without applying. */
/** How to put back a checkout an apply left half written. */
export interface PartialApply {
  readonly expectedBranch?: string
  readonly expectedDetached?: boolean
  readonly targetBranch?: string
}

export type ApplyBaseChoice = "discard_winner"

/** What a turn keeps of its attachments: labels for the app, and an excerpt for the judge. Never bytes. */
export type AttachmentSummary = {
  readonly kind: "image" | "text" | "file"
  readonly label: string
  readonly excerpt?: string
}

export type TurnDocument = {
  readonly _id: Identifier
  readonly chatID: Identifier
  readonly participantID?: string
  readonly turnIndex: number
  readonly userPrompt: string
  /** What the prompt carried besides its text; the contestants' sessions hold the attachments themselves. */
  readonly userAttachments?: readonly AttachmentSummary[]
  readonly frozenBaseSHA: string
  readonly baseSnapshot?: {
    readonly canonicalHead: string
    readonly tree: string
    readonly indexTree: string
    readonly permanentRef: string
  }
  readonly copySnapshot?: {
    readonly manifestID: Identifier
    readonly ignoredSeedID: Identifier
    readonly resolvedPolicy: ResolvedArenaCopyPolicy
  }
  setupTimings?: TurnSetupTimings
  /** Work currently keeping the turn in an active transition. */
  activeOperations?: readonly ArenaActiveOperation[]
  operationProgress?: readonly ArenaOperationProgress[]
  warmPreparation?: WarmPreparation
  transitionEventID?: Identifier
  transitionEvent?: EnvironmentTransition
  readonly sourceCanonicalSessionID: string
  autoAccept?: boolean
  readonly canonicalTranscriptHash: string
  readonly pair: readonly [string, string]
  readonly placement: Record<Side, HiddenAssignment>
  readonly runIDs: Record<Side, Identifier>
  state: BattleState
  transitionTimestamps: Partial<Record<BattleState, Date>>
  finalizedSides?: Side[]
  selectableSides?: Side[]
  comparisonState: "pending" | "running" | "complete" | "skipped" | "failed"
  comparisonID?: Identifier
  failureReason?: string
  resolution?: Resolution
  vote?: Vote
  voteParticipantID?: string
  selectedEarly?: boolean
  /** Replies sent to the contestants while the battle ran. */
  steerCount?: number
  appliedSide?: Side
  voteAt?: Date
  revealAt?: Date
  applicationAt?: Date
  canonicalizationAt?: Date
  timeToVoteMs?: number
  resultingCanonicalSHA?: string
  promotedSessionID?: string
  canonicalUserMessageID?: string
  /**
   * When the winner's transcript finished copying into the canonical session.
   *
   * The graft's remnant drop clears every canonical message at or after `canonicalUserMessageID`,
   * which is only safe while nothing but the graft has written there. A parked promotion breaks
   * that: the user prompts an agent to resolve the conflict, and those messages sort after the
   * anchor. This marker is how a retry knows the copy already happened and must not drop anything.
   */
  canonicalGraftedAt?: Date
  gitApplication?: {
    readonly state:
      | "pending"
      | "applied"
      | "blocked"
      | "failed"
      | "conflicted"
      | "manual"
      | "review"
      | "discarded"
    readonly reason?: string
    readonly resultCommit?: string
    readonly branch?: string
    readonly baseCommit?: string
    readonly conflicts?: readonly string[]
    /**
     * `review` only: the questions the developer must answer before anything is written, and
     * the refs that will be written without asking once they do.
     */
    readonly review?: {
      readonly items: readonly ReviewItem[]
      readonly planned: readonly PlannedRef[]
      /** The branch the workspace switches to once the review is answered. */
      readonly switchTo?: string
    }
    /**
     * The checkout holds part of the winner and Arena could not undo it. The developer's state
     * before the apply is still on the turn's safety refs; these are what restoring needs.
     */
    readonly partial?: PartialApply
    /** Where a discarded checkout state was preserved, so the user can get it back. */
    readonly discardedRef?: string
    /** Refs the vote wrote or skipped, the checkout's own branch first when Arena combined or created it. */
    readonly refs?: readonly RefOutcome[]
    /** The branch the vote moved this workspace to, when it is not the one the battle started on. */
    readonly switchedTo?: string
  }
  /** Set when the developer discards the winner from a parked application. */
  applyBaseChoice?: ApplyBaseChoice
  /** The developer's answers to the review, matched to its items by key and fingerprint. */
  reviewAnswers?: readonly ReviewAnswer[]
  cleanup?: {
    readonly state: "pending" | "complete" | "failed"
    readonly error?: string
  }
  readonly createdAt: Date
  updatedAt: Date
}

export type RunDocument = {
  readonly _id: Identifier
  readonly turnID: Identifier
  readonly side: Side
  readonly rootSessionID: string
  descendantSessionIDs: string[]
  readonly sourceCanonicalSessionID: string
  readonly forkOperationID: string
  readonly moveOperationID: string
  mappingArtifactID?: Identifier
  promptMessageID?: string
  terminalAssistantMessageID?: string
  readonly proxyAssignmentID: string
  readonly assignment: HiddenAssignment
  readonly worktree: string
  readonly branchAtRun?: string
  readonly worktreeName?: string
  readonly copyManifestID?: Identifier
  readonly copyOmissions?: readonly CopyOmission[]
  readonly portAliases?: Partial<Record<ArenaPortAlias, number>>
  services?: CapturedService[]
  retention?: "none" | "retained_until_next_send" | "cleanup_failed"
  readonly worktreeCreatedAt: Date
  readyAt?: Date
  startedAt?: Date
  firstEventAt?: Date
  lastEventAt?: Date
  firstTokenAt?: Date
  firstToolAt?: Date
  completedAt?: Date
  archivedAt?: Date
  durationMs: number | null
  runState: "pending" | "complete" | "stopped" | "error" | "interrupted"
  error?: string
  retries: ReadonlyArray<GenerationRetry>
  resolvedProviders?: string[]
  permissionOutcomes: ReadonlyArray<Readonly<Record<string, unknown>>>
  autoAccept?: boolean
  questionOutcomes: ReadonlyArray<Readonly<Record<string, unknown>>>
  toolCount: number
  testCommands: string[]
  rawHead?: string
  finalBranch?: string
  branchChanged?: boolean
  /** Refs the contestant moved, created, or deleted besides its own branch, recorded at finalize. */
  refChanges?: readonly RefChange[]
  agentCommit?: string
  agentCommits?: readonly string[]
  wrapperCreated?: boolean
  finalCommit?: string
  finalTree?: string
  finalIndexTree?: string
  fullyCommitted?: boolean
  baseIsAncestor?: boolean
  applicability?: "unknown" | "applicable" | "non_descendant" | "blocked"
  permanentRef?: string
  refVerifiedAt?: Date
  diff?: {
    readonly files: number
    readonly additions: number
    readonly deletions: number
  }
  usage?: UsageTotals
  transcriptArchiveID?: Identifier
  archiveComplete?: boolean
  selectable?: boolean
  finalizedAt?: Date
  worktreeRemovedAt?: Date
  projectRegistrationRemovedAt?: Date
  readonly createdAt: Date
  updatedAt: Date
}

export type GenerationRetry = {
  readonly requestID: string
  readonly generationID: Identifier
  readonly retryParentID: Identifier
  readonly attemptIndex: number
  readonly observedAt: Date
}

export type GenerationDocument = {
  readonly _id: Identifier
  readonly runID: Identifier
  readonly rootSessionID: string
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly callIndex: number
  readonly requestID: string
  readonly retryParentID?: string
  readonly providerGenerationID?: string
  readonly assignmentID: string
  readonly requestedModel: string
  readonly requestedReasoning: Readonly<Record<string, unknown>>
  readonly enforcedReasoning: Readonly<Record<string, unknown>>
  readonly classification: "root" | "subagent" | "compaction"
  readonly startedAt: Date
  responseHeadersAt?: Date
  firstTokenAt?: Date
  completedAt?: Date
  usage?: UsageTotals
  finishReason?: string
  error?: string
  requestArtifactID?: Identifier
  responseArtifactID?: Identifier
  readonly payloadHashes?: {
    readonly request?: string
    readonly response?: string
  }
  readonly routing?: Readonly<Record<string, unknown>>
}

export type ArenaEventDocument = {
  readonly _id: Identifier
  readonly turnID: Identifier
  readonly runID?: Identifier
  readonly sessionID?: string
  readonly durableSequence?: number
  readonly sequence: number
  readonly serverAt?: Date
  readonly receivedAt: Date
  readonly type: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly redactionVersion: string
  readonly normalizationVersion: string
  readonly coalesced: boolean
  readonly gap: boolean
  readonly snapshotKey?: string
  readonly contentHash?: string
  readonly firstSequence?: number
  readonly firstReceivedAt?: Date
  readonly updateCount?: number
  readonly duplicateCount?: number
}

export type RawEventDocument = {
  readonly _id: Identifier
  readonly turnID: Identifier
  readonly runID: Identifier
  readonly rootSessionID: string
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly receiveSequence: number
  readonly receivedAt: Date
  readonly type: string
  readonly directory?: string
  readonly workspaceID?: string
  readonly durableID?: string
  readonly durableSequence?: number
  readonly durableVersion?: number
  readonly classification: "live" | "delta" | "sync" | "duplicate" | "arena"
  readonly normalizedEventID?: Identifier
  readonly payload?: Readonly<Record<string, unknown>>
  readonly artifactID?: Identifier
  readonly originalSize: number
  readonly storedSize: number
  readonly contentHash: string
  readonly truncated: boolean
  readonly snapshotKey?: string
  readonly firstReceiveSequence?: number
  readonly firstReceivedAt?: Date
  readonly updateCount?: number
  readonly duplicateCount?: number
}

export type SessionArchiveDocument = {
  readonly _id: Identifier
  readonly runID: Identifier
  readonly rootSessionID: string
  readonly sessions: ReadonlyArray<{
    readonly sessionID: string
    readonly parentSessionID?: string
    readonly runState: string
    readonly error?: string
    readonly messageCount: number
    readonly messageBoundary?: { readonly first: string; readonly last: string }
    readonly sequenceBounds?: { readonly first: number; readonly last: number }
  }>
  readonly artifactIDs: Identifier[]
  readonly contentHash: string
  readonly serializationVersion: string
  readonly originalSize: number
  readonly storedSize: number
  readonly truncated: boolean
  readonly createdAt: Date
}

export type ArtifactDocument = {
  readonly _id: Identifier
  readonly runID?: Identifier
  readonly turnID?: Identifier
  readonly kind: "tool_output" | "generation_request" | "generation_response" | "patch" | "transcript" | "other"
  readonly mimeType: string
  readonly encoding: "binary" | "utf8" | "json"
  readonly compression: "none" | "gzip"
  readonly data: Buffer
  readonly originalSize: number
  readonly storedSize: number
  readonly contentHash: string
  readonly truncated: boolean
  readonly truncationReason?: "artifact_limit" | "run_limit"
  readonly createdAt: Date
}

export type ComparisonDocument = {
  readonly _id: Identifier
  readonly turnID: Identifier
  readonly baseCommit: string
  readonly aCommit: string
  readonly bCommit: string
  readonly baseTree: string
  readonly aTree: string
  readonly bTree: string
  readonly artifactIDs: Identifier[]
  readonly utilityInputManifest: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly truncated: boolean
  readonly omittedArtifacts: ReadonlyArray<string>
  readonly promptVersion: string
  readonly model: "minimax/minimax-m2.7"
  readonly provider: "groq"
  resolvedProvider?: string
  requestArtifactID?: Identifier
  responseArtifactID?: Identifier
  state: "pending" | "running" | "complete" | "failed"
  output?: string
  usage?: UsageTotals
  latencyMs?: number
  error?: string
  readonly createdAt: Date
  updatedAt: Date
}

export const reviewTabs = ["verdict", "changes"] as const
export type ReviewTab = (typeof reviewTabs)[number]

export const reviewLayouts = ["split", "single"] as const
export type ReviewLayout = (typeof reviewLayouts)[number]

/**
 * What a voter did while reviewing a battle, discriminated so an event cannot
 * carry a field that does not belong to it. No variant names a model: the
 * client does not know which model it draws, and this stream must not become
 * the thing that tells it.
 */
export type ReviewEvent =
  | { readonly type: "battle.opened" }
  | { readonly type: "window.focus" }
  | { readonly type: "window.blur" }
  | { readonly type: "focus.toggled"; readonly on: boolean }
  | { readonly type: "tab.viewed"; readonly tab: ReviewTab }
  | { readonly type: "verdict.expanded" }
  /** The report was long enough to clip, so `Show full verdict` was on offer. */
  | { readonly type: "verdict.folded" }
  | { readonly type: "file.selected"; readonly file: string; readonly index: number }
  | { readonly type: "diff.scrolled"; readonly file: string; readonly depth: number }
  | { readonly type: "layout.changed"; readonly layout: ReviewLayout }
  | { readonly type: "contestant.expanded"; readonly side: Side }
  | { readonly type: "activity.expanded"; readonly side: Side }
  | { readonly type: "vote.hovered"; readonly side: Side }
  /** The voter opened a contestant's running app through the preview proxy. */
  | { readonly type: "preview.opened"; readonly side: Side }

export type ReviewEventType = ReviewEvent["type"]

export type ReviewEventEnvelope = {
  /** Client-generated ULID, so a flush the app replays dedupes on insert. */
  readonly _id: Identifier
  /**
   * One value per mounting of the card. `offsetMs` restarts at zero each time,
   * so a turn reviewed twice holds two timelines; without this the rollup would
   * interleave them and invent gaps between events minutes apart.
   */
  readonly mountId: string
  readonly turnID: Identifier
  readonly chatID: Identifier
  readonly participantID?: string
  readonly userId?: string
  /** The socket's peer as the daemon saw it. Not client-supplied, so it can be trusted. */
  readonly ipAddress?: string
  /**
   * Milliseconds from the client's own battle-start reference. Dwell is
   * computed from these rather than from `clientAt`, which a skewed clock
   * turns into negative intervals.
   */
  readonly offsetMs: number
  /** Kept only to measure skew against `receivedAt`. Never subtract two of these. */
  readonly clientAt: Date
  readonly receivedAt: Date
}

export type ReviewEventDocument = ReviewEventEnvelope & ReviewEvent

export type ReviewIngestResult = {
  readonly received: number
  readonly accepted: number
}

/**
 * What the app sends. Everything else on the document is stamped by the
 * backend. The clock crosses the wire as epoch milliseconds so no timezone or
 * parse ambiguity sits between the client and the record.
 */
export type ReviewEventInput = {
  readonly id: Identifier
  readonly mountId: string
  readonly offsetMs: number
  readonly clientAtMs: number
} & ReviewEvent

/** Events per flush. A larger batch is a bug in the client's buffer, not a big review. */
export const reviewFlushLimit = 500

/** Bump when a derived field changes meaning, then recompute the whole table. */
export const battleMetricsSchemaVersion = 5

export type ReviewEffort = {
  /** From the card opening to the first act of reviewing, ignoring window focus events. */
  readonly msToFirstInteraction?: number
  readonly panesOpened: readonly ReviewTab[]
  readonly dwellMsByPane: Readonly<Record<string, number>>
  readonly filesViewed: number
  /** Contestants whose preview the voter opened: 0, 1 or both. */
  readonly previewsOpened: number
  /**
   * Whether the voter unfolded the judge's report. Absent when no fold was ever
   * offered — a short verdict shows whole and a stopped battle has none — so
   * `false` means they left it folded rather than there being nothing to open.
   */
  readonly verdictExpanded?: boolean
  /** Time with the review open and the window focused, with idle spans dropped. */
  readonly activeMs: number
  /** Every stored event, passive ones included. A completeness check, not a measure of effort. */
  readonly eventCount: number
  /** Only what the voter did: tabs, files, previews, unfolding. */
  readonly interactionCount: number
  /**
   * Contestants whose vote control the pointer visited: 0, 1 or both. Only a
   * pointer can cause this, so unlike a tab it is never the card acting on its
   * own — which makes it the one signal that separates a reader who looked from
   * a voter who did not.
   */
  readonly votesHovered: number
  /**
   * How far into a diff the reader got, as a fraction, taking the deepest of
   * whatever files they opened. Absent when nothing was scrolled: a diff shorter
   * than its viewport cannot be scrolled, so 0 would read as "never bothered".
   */
  readonly deepestDiffDepth?: number
}

/**
 * One flat row per contestant per turn, derived from the battle documents when
 * a turn resolves. Nothing reads it during a battle and nothing here reaches a
 * client, so it carries true model identity. Recompute rather than patch when a
 * definition changes: a column that means two things across a date is worse
 * than one that was never collected.
 */
/** One contestant's side of a battle. */
export type BattleSideMetrics = {
  readonly model: string
  readonly providers: readonly string[]
  readonly llmCalls: number
  readonly latencyMs: number
  readonly ttftMs?: number
  readonly tokensPerSec?: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly cost: number
  readonly providerErrors: number
  readonly retries: number
  readonly finishReason?: string
  readonly runState: RunDocument["runState"]
  readonly runErrored: boolean
  readonly durationMs?: number
  /** Offset from the turn's start, so the sequence the voter saw can be rebuilt. */
  readonly completedAtMs?: number
  readonly finishedFirst?: boolean
  readonly toolCount: number
  /** Processes the contestant started that were still alive when the run settled. */
  readonly serviceCount: number
  readonly diffFiles: number
  readonly diffAdditions: number
  readonly diffDeletions: number
  readonly summaryWordCount?: number
  /**
   * Blocks of prose the contestant addressed to the voter. Absent when the
   * transcript could not be read.
   */
  readonly textMessageCount?: number
  /** A blinding leak: the contestant named its own vendor in text the voter read. */
  readonly mentionsOwnName?: boolean
  readonly matchedAlias?: string
  /** False on both sides for a tie, which applies A to git without anyone winning. */
  readonly won: boolean
}

/**
 * One document per battle, the grain the decision actually has, with each
 * contestant nested the way `TurnDocument` already nests `placement` and
 * `runIDs`. Everything outside `sides` describes the turn once rather than
 * twice, so `COUNT(*)` counts battles and a turn-level average cannot be
 * double-weighted. The Parquet export flattens this to one row per
 * `(turn, side)` for analysis; see [analytics](../../../../docs/analytics.md).
 */
export type BattleMetricsDocument = {
  /** The turn's id: one battle, one document, so a recompute replaces it. */
  readonly _id: Identifier
  readonly schemaVersion: number
  readonly computedAt: Date
  readonly turnID: Identifier
  readonly chatID: Identifier
  readonly turnIndex: number
  readonly userId?: string
  readonly participantID?: string
  readonly ipAddress?: string
  /** Both contestants, sorted, so every battle between the same two groups together. */
  readonly modelPair: readonly string[]
  /** The vote as cast. `won` is false on both sides for a tie; this is how you find them. */
  readonly vote?: Vote
  readonly resolutionKind?: string
  readonly selectedEarly: boolean
  /** A steer reaches both contestants, so it belongs to the turn, not a side. */
  readonly steerCount: number
  readonly voteAtMs?: number
  readonly timeToVoteMs?: number
  readonly review?: ReviewEffort
  /** A side with no run is absent rather than invented. */
  readonly sides: Partial<Record<Side, BattleSideMetrics>>
}

export type BattleHistoryTurn = Pick<
  TurnDocument,
  | "_id"
  | "turnIndex"
  | "state"
  | "resolution"
  | "vote"
  | "selectedEarly"
  | "appliedSide"
  | "canonicalUserMessageID"
  | "gitApplication"
  | "transitionEvent"
  | "transitionTimestamps"
  | "placement"
  | "createdAt"
  | "updatedAt"
>

export type BattleSnapshot = {
  readonly chat: ChatDocument
  readonly singleAgentRating?: SingleAgentRatingDocument
  readonly turn?: TurnDocument
  readonly history?: readonly BattleHistoryTurn[]
  readonly runs: readonly RunDocument[]
  readonly events: readonly ArenaEventDocument[]
  readonly comparison?: ComparisonDocument
}

export * as ArenaRecords from "./records"
