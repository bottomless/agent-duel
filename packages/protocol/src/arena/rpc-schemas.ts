import { z } from "zod";

export const ArenaSideSchema = z.enum(["a", "b"]);
export const ArenaReplyTargetSchema = z.enum(["a", "b", "both"]);
export const ArenaVoteSchema = z.enum(["a", "b", "tie"]);
export const ArenaBattleStateSchema = z.enum([
  "creating",
  "worktrees_ready",
  "running",
  "early_selected",
  "finalizing",
  "awaiting_vote",
  "applying",
  "canonicalizing",
  "cleanup_pending",
  "complete",
  "stopping",
  "awaiting_stop_resolution",
  "discarding",
  "discarded",
  "creation_failed",
  "finalization_failed",
  "application_failed",
  "canonicalization_failed",
  "interrupted_recovery",
]);
export const ArenaActiveOperationSchema = z.enum([
  "preparing_workspaces",
  "copying_environment",
  "checking_workspace",
  "releasing_environment",
  "preserving_results",
  "applying_changes",
  "updating_conversation",
  "releasing_loser",
]);
export const ArenaOperationProgressSchema = z.discriminatedUnion("state", [
  z
    .object({
      operation: ArenaActiveOperationSchema,
      startedAt: z.number(),
      state: z.literal("running"),
    })
    .passthrough(),
  z
    .object({
      operation: ArenaActiveOperationSchema,
      startedAt: z.number(),
      finishedAt: z.number(),
      state: z.literal("completed"),
    })
    .passthrough(),
  z
    .object({
      operation: ArenaActiveOperationSchema,
      startedAt: z.number(),
      finishedAt: z.number(),
      state: z.literal("failed"),
    })
    .passthrough(),
  z
    .object({
      operation: ArenaActiveOperationSchema,
      startedAt: z.number(),
      finishedAt: z.number(),
      state: z.literal("interrupted"),
    })
    .passthrough(),
]);

const ArenaIdentitySchema = z.object({ name: z.string() }).passthrough();
const ArenaIdentitiesSchema = z
  .object({ a: ArenaIdentitySchema, b: ArenaIdentitySchema })
  .passthrough();

// Keep this public shape to UI-safe labels and relative diagnostics. Absolute
// paths and copy identities remain behind trusted local-host inspection surfaces.
const ArenaCopyOmissionSchema = z
  .object({
    relativePath: z.string(),
    omissionReason: z.string().optional(),
  })
  .passthrough();

const ArenaServiceSchema = z
  .object({
    kind: z.literal("owned_process"),
    command: z.string(),
    relativeCwd: z.string(),
    listeners: z.array(
      z
        .object({
          port: z.number(),
          alias: z.string().optional(),
        })
        .passthrough(),
    ),
    proxyRoutes: z.array(
      z
        .object({
          hostname: z.string(),
          url: z.string().optional(),
          port: z.number().optional(),
          alias: z.string().optional(),
          active: z.boolean(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const ArenaTransitionStoppedCommandSchema = z
  .object({
    command: z.string(),
    relativeCwd: z.string(),
    status: z.enum(["stopped", "already_absent", "failed"]),
    verified: z.boolean(),
    listeners: z
      .array(
        z
          .object({
            alias: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    error: z.string().optional(),
  })
  .passthrough();

const ArenaTransitionSummarySchema = z
  .object({
    commandsStopped: z.number(),
    commandsAlreadyAbsent: z.number(),
    stopFailures: z.number(),
    listenersReleased: z.number(),
    pathsOmitted: z.number(),
  })
  .passthrough();

const ArenaEnvironmentTransitionSchema = z
  .object({
    id: z.string(),
    previousWinningRunID: z.string(),
    stoppedCommands: z.array(ArenaTransitionStoppedCommandSchema),
    copyOmissions: z.array(ArenaCopyOmissionSchema),
    summary: ArenaTransitionSummarySchema.optional(),
    createdAt: z.string(),
  })
  .passthrough();

/** A retry's mode: drop the winner, or put back a checkout an apply left half written. */
export const ArenaRetryModeSchema = z.enum(["discard_winner", "restore_workspace"]);
export type ArenaRetryMode = z.infer<typeof ArenaRetryModeSchema>;

const ArenaRefOutcomeSchema = z
  .object({
    ref: z.string(),
    action: z.enum(["created", "updated", "deleted", "skipped"]),
    reason: z.string().optional(),
    /** Where the value the write replaced is kept. */
    backupRef: z.string().optional(),
    /** Commits the ref no longer reaches after the write. */
    removed: z.number().optional(),
    /** How a branch both sides changed was combined, when Arena replayed one side onto the other. */
    how: z.enum(["agent_on_yours", "yours_on_agent"]).optional(),
  })
  .passthrough();

export const ArenaBranchActionSchema = z.enum([
  "agent",
  "yours",
  "agent_on_yours",
  "yours_on_agent",
  "combine",
]);
export type ArenaBranchAction = z.infer<typeof ArenaBranchActionSchema>;
const ArenaAgentMoveSchema = z.enum(["created", "added", "rewrote", "deleted"]);
const ArenaYourMoveSchema = z.enum(["untouched", "created", "added", "rewrote", "deleted"]);
const ArenaOccupiedChoiceSchema = z.enum(["take", "stay"]);

/**
 * One question the review asks before the winner is written. `key` names its subject -- a full
 * ref name, or `@edits`, `@occupied`, `@busy` -- and `fingerprint` changes when
 * the situation behind it does; an answer carries both back.
 */
export const ArenaReviewItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ref"),
      key: z.string(),
      fingerprint: z.string(),
      namespace: z.enum(["branch", "tag", "remote"]),
      agentMove: ArenaAgentMoveSchema,
      yourMove: ArenaYourMoveSchema,
      proposal: z.union([ArenaBranchActionSchema, z.literal("ask_agent")]),
      choices: z.array(ArenaBranchActionSchema),
      checkout: z.boolean(),
      checkedOutAt: z.string().optional(),
      clash: z.array(z.string()).optional(),
      agentRef: z.string().optional(),
      lost: z.number().optional(),
      lostSubjects: z.array(z.string()).optional(),
      rewound: z.boolean().optional(),
      agentSubject: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("edits"),
      key: z.literal("@edits"),
      fingerprint: z.string(),
      paths: z.array(z.string()),
      unmergeable: z.array(z.string()),
      choices: z.array(z.enum(["combine", "agent", "yours"])),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("occupied"),
      key: z.literal("@occupied"),
      fingerprint: z.string(),
      branch: z.string(),
      path: z.string(),
      proposal: ArenaOccupiedChoiceSchema,
      choices: z.array(ArenaOccupiedChoiceSchema),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("busy"),
      key: z.literal("@busy"),
      fingerprint: z.string(),
      operation: z.string(),
    })
    .passthrough(),
]);
export type ArenaReviewItem = z.infer<typeof ArenaReviewItemSchema>;

export const ArenaReviewAnswerSchema = z.object({
  key: z.string(),
  fingerprint: z.string(),
  choice: z.union([ArenaBranchActionSchema, ArenaOccupiedChoiceSchema]),
});
export type ArenaReviewAnswer = z.infer<typeof ArenaReviewAnswerSchema>;

const ArenaGitApplicationSchema = z
  .object({
    // `review` alone describes work not yet done: the promotion stopped before writing anything,
    // and `review.items` are the questions it needs answered first.
    state: z.enum([
      "pending",
      "applied",
      "blocked",
      "failed",
      "conflicted",
      "manual",
      "review",
      "discarded",
    ]),
    reason: z.string().optional(),
    resultCommit: z.string().optional(),
    branch: z.string().optional(),
    baseCommit: z.string().optional(),
    conflicts: z.array(z.string()).optional(),
    /** `review` only: the open questions, and the refs written without asking once they are answered. */
    review: z
      .object({
        items: z.array(ArenaReviewItemSchema),
        planned: z.array(
          z.object({ ref: z.string(), action: ArenaBranchActionSchema }).passthrough(),
        ),
        switchTo: z.string().optional(),
      })
      .passthrough()
      .optional(),
    /** The workspace holds part of the winner and Arena could not undo it; restoring puts it back. */
    partial: z.object({}).passthrough().optional(),
    /** Where a discarded workspace state was preserved, so the user can get it back. */
    discardedRef: z.string().optional(),
    /** Refs the vote wrote or skipped, the checkout's own branch first when Arena combined or created it. */
    refs: z.array(ArenaRefOutcomeSchema).optional(),
    /** The branch the vote moved this workspace to, when it is not the one the battle started on. */
    switchedTo: z.string().optional(),
  })
  .passthrough();

const ArenaResolutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("vote"),
      vote: ArenaVoteSchema,
      appliedSide: ArenaSideSchema,
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("stopped"),
      resolution: z.enum(["discard", "apply_a", "apply_b"]),
      appliedSide: ArenaSideSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("early"),
      vote: ArenaSideSchema,
      appliedSide: ArenaSideSchema,
    })
    .passthrough(),
  z.object({ kind: z.literal("aborted"), reason: z.string() }).passthrough(),
]);

export const ArenaHistoryItemSchema = z
  .object({
    id: z.string(),
    index: z.number(),
    state: ArenaBattleStateSchema,
    resolution: ArenaResolutionSchema.optional(),
    vote: ArenaVoteSchema.optional(),
    selectedEarly: z.boolean().optional(),
    appliedSide: ArenaSideSchema.optional(),
    canonicalUserMessageID: z.string().optional(),
    endedAt: z.string().optional(),
    identities: ArenaIdentitiesSchema.optional(),
    gitApplication: ArenaGitApplicationSchema.optional(),
    transition: ArenaEnvironmentTransitionSchema.optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const ArenaRunSchema = z
  .object({
    id: z.string(),
    side: ArenaSideSchema,
    sessionID: z.string(),
    descendantSessionIDs: z.array(z.string()),
    worktree: z.string(),
    worktreeName: z.string(),
    branchAtRun: z.string().optional(),
    worktreeActive: z.boolean(),
    copyOmissions: z.array(ArenaCopyOmissionSchema).optional(),
    portAliases: z.record(z.string(), z.number()).optional(),
    services: z.array(ArenaServiceSchema).optional(),
    retention: z.enum(["none", "retained_until_next_send", "cleanup_failed"]).optional(),
    runState: z.enum(["pending", "complete", "stopped", "error", "interrupted"]),
    error: z.string().optional(),
    startedAt: z.string().optional(),
    firstEventAt: z.string().optional(),
    lastEventAt: z.string().optional(),
    completedAt: z.string().optional(),
    durationMs: z.number().nullable(),
    promptMessageID: z.string().optional(),
    diff: z
      .object({
        files: z.number(),
        additions: z.number(),
        deletions: z.number(),
      })
      .passthrough()
      .optional(),
    finalCommit: z.string().optional(),
    finalTree: z.string().optional(),
    permanentRef: z.string().optional(),
    selectable: z.boolean(),
    applicable: z.boolean(),
    identity: ArenaIdentitySchema.optional(),
    messages: z.array(z.unknown()).optional(),
    parts: z.record(z.string(), z.array(z.unknown())).optional(),
    status: z.unknown().optional(),
    permissions: z.array(z.unknown()).optional(),
    questions: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const ArenaSnapshotSchema = z
  .object({
    chat: z
      .object({
        id: z.string(),
        status: z.enum(["ready", "battle_active", "blocked", "failed", "archived"]),
        canonicalSessionID: z.string(),
        canonicalSHA: z.string(),
        activeTurnID: z.string().optional(),
        blockedReason: z.string().optional(),
        trunkConflicts: z.array(z.string()).optional(),
        trunk: z
          .object({
            worktreeName: z.string(),
            branch: z.string().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
    environment: z
      .object({
        retainedWinner: z
          .object({
            runID: z.string(),
            side: ArenaSideSchema,
            worktreeName: z.string(),
            branch: z.string().optional(),
            state: z.enum(["live", "stopping", "cleanup_failed"]),
          })
          .passthrough()
          .optional(),
        warmPair: z
          .object({
            generation: z.number(),
            state: z.enum(["pending", "ready", "failed"]),
            sides: z.array(
              z
                .object({
                  side: ArenaSideSchema,
                  worktreeName: z.string(),
                  branch: z.string().optional(),
                  ready: z.boolean(),
                })
                .passthrough(),
            ),
            error: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    singleAgent: z
      .object({
        id: z.string(),
        revealed: z.boolean(),
        vote: z.enum(["up", "down"]).optional(),
        identity: ArenaIdentitySchema.optional(),
      })
      .passthrough()
      .optional(),
    turn: ArenaHistoryItemSchema.extend({
      prompt: z.string(),
      attachments: z
        .array(z.object({ kind: z.enum(["image", "text", "file"]), label: z.string() }))
        .optional(),
      baseSHA: z.string(),
      comparisonState: z.enum(["pending", "running", "complete", "skipped", "failed"]),
      activeOperations: z.array(ArenaActiveOperationSchema).optional(),
      operationProgress: z.array(ArenaOperationProgressSchema).optional(),
      canVote: z.boolean(),
      canRetryResolution: z.boolean(),
      canDiscardWinner: z.boolean().optional(),
      revealed: z.boolean(),
    })
      .passthrough()
      .optional(),
    history: z.array(ArenaHistoryItemSchema),
    runs: z.array(ArenaRunSchema),
    events: z.array(z.unknown()),
    comparison: z
      .object({
        state: z.enum(["pending", "running", "complete", "failed"]),
        output: z.string().optional(),
        truncated: z.boolean(),
        omittedArtifacts: z.array(z.string()),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ArenaDiffStatSchema = z
  .object({
    file: z.string(),
    additions: z.number(),
    deletions: z.number(),
    binary: z.boolean(),
  })
  .passthrough();

// Where one retained run of lines starts in this side's file, 1-based.
const ArenaFileRegionSchema = z
  .object({
    start: z.number(),
    lines: z.number(),
  })
  .passthrough();

const ArenaFileContentSchema = z
  .object({
    content: z.string(),
    truncated: z.boolean(),
    missing: z.boolean(),
    // Absent means content is the whole file -- an older daemon never sends it. Present, it
    // says which parts of the file content holds, so the viewer can number lines correctly
    // and name what sits between them instead of running them together.
    regions: z.array(ArenaFileRegionSchema).optional(),
    // Lines in the whole file, sent alongside regions so the viewer can name the part
    // after the last window as well as the parts between them.
    lines: z.number().optional(),
  })
  .passthrough();

// One row per file touched by either contestant, carrying its content at base, A,
// and B so the UI can render a three-way comparison (Agent A / base / Agent B)
// instead of an A -> B delta that mixes both sides' edits into one confusing patch.
const ArenaThreeWayFileSchema = z
  .object({
    file: z.string(),
    binary: z.boolean(),
    additionsA: z.number(),
    deletionsA: z.number(),
    additionsB: z.number(),
    deletionsB: z.number(),
    base: ArenaFileContentSchema.optional(),
    a: ArenaFileContentSchema.optional(),
    b: ArenaFileContentSchema.optional(),
  })
  .passthrough();

// How the two contestants' work on one file relates, decided by git's three-way merge
// of A and B over the frozen base: `diverging` is a conflict (same region, different
// content), `compatible` merged cleanly, `identical` is the same result on both sides,
// `only_a`/`only_b` means the other side left the file alone.
export const ArenaDivergenceStatusSchema = z.enum([
  "identical",
  "only_a",
  "only_b",
  "compatible",
  "diverging",
  "binary",
]);

const ArenaDivergenceFileSchema = z
  .object({
    file: z.string(),
    status: ArenaDivergenceStatusSchema,
    // The file as merge-tree wrote it, conflicts left as zdiff3 blocks. Only for
    // compatible and diverging files small enough to send whole.
    merged: ArenaFileContentSchema.optional(),
  })
  .passthrough();

export const ArenaDivergenceSchema = z
  .object({
    mergeTree: z.string(),
    conflicted: z.boolean(),
    // Same set and order as `files`.
    files: z.array(ArenaDivergenceFileSchema),
  })
  .passthrough();

export const ArenaComparisonDiffSchema = z
  .object({
    turnID: z.string(),
    baseCommit: z.string(),
    a: z
      .object({
        commit: z.string(),
        tree: z.string(),
        ref: z.string().optional(),
      })
      .passthrough(),
    b: z
      .object({
        commit: z.string(),
        tree: z.string(),
        ref: z.string().optional(),
      })
      .passthrough(),
    treesEqual: z.boolean(),
    // Optional: an older daemon won't send per-file three-way content yet.
    files: z.array(ArenaThreeWayFileSchema),
    filesTruncated: z.boolean(),
    patch: z.string(),
    truncated: z.boolean(),
    stats: z.array(ArenaDiffStatSchema),
    // Absent from an older daemon, or when merge-tree could not run; the viewer then
    // shows the three columns without file statuses or the combined view.
    divergence: ArenaDivergenceSchema,
  })
  .passthrough();

const ArenaAgentRequestFields = {
  requestId: z.string(),
  agentId: z.string(),
} as const;
/** Events per flush. A larger batch means the client's buffer is broken, not that the review was long. */
export const ARENA_REVIEW_FLUSH_LIMIT = 500;
const ArenaReviewEventFields = {
  id: z.string(),
  /** One value per mounting of the card; `offsetMs` restarts at zero with it. */
  mountId: z.string(),
  offsetMs: z.number(),
  clientAtMs: z.number(),
} as const;
const ArenaSnapshotResponsePayloadSchema = z.object({
  requestId: z.string(),
  snapshot: ArenaSnapshotSchema,
});

export const ArenaSessionResolveRequestSchema = z.object({
  type: z.literal("arena.session.resolve.request"),
  ...ArenaAgentRequestFields,
});
export const ArenaSessionResolveResponseSchema = z.object({
  type: z.literal("arena.session.resolve.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
export const ArenaSingleAgentVoteRequestSchema = z.object({
  type: z.literal("arena.single_agent.vote.request"),
  ...ArenaAgentRequestFields,
  ratingId: z.string().optional(),
  vote: z.enum(["up", "down"]),
});
export const ArenaSingleAgentVoteResponseSchema = z.object({
  type: z.literal("arena.single_agent.vote.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
/**
 * `available`: this daemon runs Arena on the user's own OpenRouter key instead of an account.
 * `configured`: it holds that key in memory.
 */
export const ArenaByokStatusSchema = z.object({
  available: z.boolean(),
  configured: z.boolean(),
});
export type ArenaByokStatus = z.infer<typeof ArenaByokStatusSchema>;
export const ArenaByokStatusGetRequestSchema = z.object({
  type: z.literal("arena.byok.status.get.request"),
  requestId: z.string(),
});
export const ArenaByokStatusGetResponseSchema = z.object({
  type: z.literal("arena.byok.status.get.response"),
  payload: z.object({
    requestId: z.string(),
    ...ArenaByokStatusSchema.shape,
  }),
});
export const ArenaByokKeySetResultSchema = z.object({ configured: z.boolean() });
export type ArenaByokKeySetResult = z.infer<typeof ArenaByokKeySetResultSchema>;
/** `null` clears the key. */
export const ArenaByokKeySetRequestSchema = z.object({
  type: z.literal("arena.byok.key.set.request"),
  requestId: z.string(),
  key: z.string().nullable(),
});
export const ArenaByokKeySetResponseSchema = z.object({
  type: z.literal("arena.byok.key.set.response"),
  payload: z.object({
    requestId: z.string(),
    ...ArenaByokKeySetResultSchema.shape,
  }),
});
export const ArenaSnapshotGetRequestSchema = z.object({
  type: z.literal("arena.snapshot.get.request"),
  ...ArenaAgentRequestFields,
  chatId: z.string(),
});
export const ArenaSnapshotGetResponseSchema = z.object({
  type: z.literal("arena.snapshot.get.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
export const ArenaTurnGetRequestSchema = z.object({
  type: z.literal("arena.turn.get.request"),
  ...ArenaAgentRequestFields,
  turnId: z.string(),
});
export const ArenaTurnGetResponseSchema = z.object({
  type: z.literal("arena.turn.get.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
/**
 * What a battle message carries besides its text, in the same shape `send_agent_message` uses.
 * Attachments stay loose here because their schema lives in `messages.ts`, which imports this file;
 * the daemon normalizes them with `normalizeAgentAttachments`.
 */
const ArenaPromptAttachmentFields = {
  images: z.array(z.object({ data: z.string(), mimeType: z.string() })).optional(),
  attachments: z.array(z.unknown()).optional(),
};
export const ArenaTurnStartRequestSchema = z.object({
  type: z.literal("arena.turn.start.request"),
  ...ArenaAgentRequestFields,
  chatId: z.string(),
  prompt: z.string(),
  ...ArenaPromptAttachmentFields,
});
export const ArenaTurnStartResponseSchema = z.object({
  type: z.literal("arena.turn.start.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
export const ArenaTurnReplyRequestSchema = z.object({
  type: z.literal("arena.turn.reply.request"),
  ...ArenaAgentRequestFields,
  turnId: z.string(),
  prompt: z.string(),
  target: ArenaReplyTargetSchema,
  ...ArenaPromptAttachmentFields,
});
export const ArenaTurnReplyResponseSchema = z.object({
  type: z.literal("arena.turn.reply.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
/**
 * What a voter did while reviewing a battle. Every variant carries `side` at
 * most: the app does not know which model it is drawing, and this stream must
 * not become the thing that tells it.
 */
export const ArenaReviewEventSchema = z.discriminatedUnion("type", [
  z.object({ ...ArenaReviewEventFields, type: z.literal("battle.opened") }),
  z.object({ ...ArenaReviewEventFields, type: z.literal("window.focus") }),
  z.object({ ...ArenaReviewEventFields, type: z.literal("window.blur") }),
  z.object({ ...ArenaReviewEventFields, type: z.literal("focus.toggled"), on: z.boolean() }),
  z.object({
    ...ArenaReviewEventFields,
    type: z.literal("tab.viewed"),
    tab: z.enum(["verdict", "changes"]),
  }),
  z.object({ ...ArenaReviewEventFields, type: z.literal("verdict.expanded") }),
  z.object({ ...ArenaReviewEventFields, type: z.literal("verdict.folded") }),
  z.object({
    ...ArenaReviewEventFields,
    type: z.literal("file.selected"),
    file: z.string(),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    ...ArenaReviewEventFields,
    type: z.literal("diff.scrolled"),
    file: z.string(),
    depth: z.number().min(0).max(1),
  }),
  z.object({
    ...ArenaReviewEventFields,
    type: z.literal("layout.changed"),
    layout: z.enum(["split", "single"]),
  }),
  z.object({
    ...ArenaReviewEventFields,
    type: z.literal("contestant.expanded"),
    side: ArenaSideSchema,
  }),
  z.object({
    ...ArenaReviewEventFields,
    type: z.literal("activity.expanded"),
    side: ArenaSideSchema,
  }),
  z.object({ ...ArenaReviewEventFields, type: z.literal("vote.hovered"), side: ArenaSideSchema }),
  z.object({ ...ArenaReviewEventFields, type: z.literal("preview.opened"), side: ArenaSideSchema }),
]);
export type ArenaReviewEvent = z.infer<typeof ArenaReviewEventSchema>;

export const ArenaReviewIngestResultSchema = z.object({
  received: z.number(),
  accepted: z.number(),
});
export type ArenaReviewIngestResult = z.infer<typeof ArenaReviewIngestResultSchema>;

export const ArenaTurnRecordReviewRequestSchema = z.object({
  type: z.literal("arena.turn.record_review.request"),
  ...ArenaAgentRequestFields,
  turnId: z.string(),
  events: z.array(ArenaReviewEventSchema).max(ARENA_REVIEW_FLUSH_LIMIT),
});
export const ArenaTurnRecordReviewResponseSchema = z.object({
  type: z.literal("arena.turn.record_review.response"),
  payload: z.object({
    requestId: z.string(),
    ...ArenaReviewIngestResultSchema.shape,
  }),
});

export const ArenaTurnVoteRequestSchema = z.object({
  type: z.literal("arena.turn.vote.request"),
  ...ArenaAgentRequestFields,
  turnId: z.string(),
  vote: ArenaVoteSchema,
});
export const ArenaTurnVoteResponseSchema = z.object({
  type: z.literal("arena.turn.vote.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
export const ArenaTurnStopRequestSchema = z.object({
  type: z.literal("arena.turn.stop.request"),
  ...ArenaAgentRequestFields,
  turnId: z.string(),
});
export const ArenaTurnStopResponseSchema = z.object({
  type: z.literal("arena.turn.stop.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
export const ArenaTurnResolveStopRequestSchema = z.object({
  type: z.literal("arena.turn.resolve_stop.request"),
  ...ArenaAgentRequestFields,
  turnId: z.string(),
  resolution: z.enum(["discard", "apply_a", "apply_b"]),
});
export const ArenaTurnResolveStopResponseSchema = z.object({
  type: z.literal("arena.turn.resolve_stop.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
export const ArenaTurnRetryComparisonRequestSchema = z.object({
  type: z.literal("arena.turn.retry_comparison.request"),
  ...ArenaAgentRequestFields,
  turnId: z.string(),
});
export const ArenaTurnRetryComparisonResponseSchema = z.object({
  type: z.literal("arena.turn.retry_comparison.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
export const ArenaTurnRetryResolutionRequestSchema = z.object({
  type: z.literal("arena.turn.retry_resolution.request"),
  ...ArenaAgentRequestFields,
  turnId: z.string(),
  /** Discards the winner instead of applying it; absent for a retry or a review answer. */
  mode: ArenaRetryModeSchema.optional(),
  /** Answers to a `review` application. */
  answers: z.array(ArenaReviewAnswerSchema).optional(),
});
export const ArenaTurnRetryResolutionResponseSchema = z.object({
  type: z.literal("arena.turn.retry_resolution.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
export const ArenaTurnDiffRequestSchema = z.object({
  type: z.literal("arena.turn.diff.request"),
  ...ArenaAgentRequestFields,
  turnId: z.string(),
});
export const ArenaTurnDiffResponseSchema = z.object({
  type: z.literal("arena.turn.diff.response"),
  payload: z.object({ requestId: z.string(), diff: ArenaComparisonDiffSchema }),
});
export const ArenaRunQuestionReplyRequestSchema = z.object({
  type: z.literal("arena.run.question.reply.request"),
  ...ArenaAgentRequestFields,
  runId: z.string(),
  questionRequestId: z.string(),
  answers: z.array(z.array(z.string())),
});
export const ArenaRunQuestionReplyResponseSchema = z.object({
  type: z.literal("arena.run.question.reply.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
export const ArenaRunQuestionRejectRequestSchema = z.object({
  type: z.literal("arena.run.question.reject.request"),
  ...ArenaAgentRequestFields,
  runId: z.string(),
  questionRequestId: z.string(),
});
export const ArenaRunQuestionRejectResponseSchema = z.object({
  type: z.literal("arena.run.question.reject.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});
export const ArenaPermissionReplySchema = z.enum(["once", "always", "reject"]);
export const ArenaRunPermissionReplyRequestSchema = z.object({
  type: z.literal("arena.run.permission.reply.request"),
  ...ArenaAgentRequestFields,
  runId: z.string(),
  permissionRequestId: z.string(),
  response: ArenaPermissionReplySchema,
});
export const ArenaRunPermissionReplyResponseSchema = z.object({
  type: z.literal("arena.run.permission.reply.response"),
  payload: ArenaSnapshotResponsePayloadSchema,
});

export type ArenaSnapshot = z.infer<typeof ArenaSnapshotSchema>;
export type ArenaRun = z.infer<typeof ArenaRunSchema>;
export type ArenaHistoryItem = z.infer<typeof ArenaHistoryItemSchema>;
export type ArenaComparisonDiff = z.infer<typeof ArenaComparisonDiffSchema>;
export type ArenaDivergence = z.infer<typeof ArenaDivergenceSchema>;
export type ArenaDivergenceFile = z.infer<typeof ArenaDivergenceFileSchema>;
export type ArenaDivergenceStatus = z.infer<typeof ArenaDivergenceStatusSchema>;
export type ArenaThreeWayFile = z.infer<typeof ArenaThreeWayFileSchema>;
export type ArenaFileContent = z.infer<typeof ArenaFileContentSchema>;
export type ArenaSide = z.infer<typeof ArenaSideSchema>;
export type ArenaReplyTarget = z.infer<typeof ArenaReplyTargetSchema>;
export type ArenaVote = z.infer<typeof ArenaVoteSchema>;
export type ArenaSingleAgentVote = "up" | "down";
export type ArenaPermissionReply = z.infer<typeof ArenaPermissionReplySchema>;
