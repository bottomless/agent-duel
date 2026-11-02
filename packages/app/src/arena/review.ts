import { i18n } from "@/i18n/i18next";
import type {
  ArenaBranchAction,
  ArenaReviewAnswer,
  ArenaReviewItem,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

/**
 * The one callout a vote parks on when applying the winner would replace something of the
 * developer's: their files, their branches, or a branch another worktree has.
 *
 * Arena applies everything that removes nothing of theirs by itself. What is left is answered
 * once, for all of it: keep mine, apply the winner's, or apply with mine kept and let an agent
 * combine the two. docs/arena.md owns the rules; this module turns items into words and answers.
 */

export type ReviewChoice = ArenaReviewAnswer["choice"];

/** The three ways out of a review, each answering every item at once. */
export type ReviewMode = "resolve" | "winner" | "mine";

type RefItem = Extract<ArenaReviewItem, { kind: "ref" }>;
type BusyItem = Extract<ArenaReviewItem, { kind: "busy" }>;

/** `refs/heads/feat/x` → `feat/x`, `refs/tags/v1` → `tag v1`, `refs/remotes/origin/main` → `origin/main`. */
export function refDisplayName(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return `tag ${ref.slice("refs/tags/".length)}`;
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  return ref;
}

function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function filesNote(paths: readonly string[]): string {
  const [first, ...rest] = paths;
  if (!first) return "";
  return rest.length === 0
    ? i18n.t("arena.inFile", { file: first })
    : i18n.t("arena.inFiles", { file: first, total: rest.length });
}

/** Whether the two sides of a ref need combining, rather than one replacing the other. */
function overlaps(item: RefItem): boolean {
  return item.proposal === "ask_agent" || item.proposal === "combine";
}

function commits(count: number): string {
  return i18n.t(count === 1 ? "arena.oneCommit" : "arena.commitCount", { total: count });
}

function quoted(subject: string | undefined): string {
  return subject ? `“${subject}”` : i18n.t("arena.olderCommit");
}

/** Which of the developer's commits would leave the branch, named, so the loss is plain. */
function leaving(item: RefItem): string[] {
  const lost = item.lost ?? 0;
  const subjects = (item.lostSubjects ?? []).toReversed();
  const more = lost - subjects.length;
  return more > 0 ? [...subjects, i18n.t("arena.more", { total: more })] : subjects;
}

/** The line the bullet list of removed commits hangs from. */
function leavingLead(item: RefItem, name: string): string {
  return (item.lost ?? 0) === 1
    ? i18n.t("arena.removedCommit", { name: name })
    : i18n.t("arena.removedCommits", { commits: commits(item.lost ?? 0), name: name });
}

/**
 * One question in the developer's terms: what the winner would do to their branch, what they
 * would lose if they apply it, and the two answers named after what each does.
 */
interface ReviewStory {
  title: string;
  /** The same story in a few words, for the list when several questions share the callout. */
  note: string;
  detail: string;
  /** The developer's commits that leave the branch, oldest first, listed under the detail. */
  leaving?: readonly string[];
  /** Short facts after the list: the backup, another worktree. */
  asides?: readonly string[];
  mine: string;
  winner: string;
}

function overlapDetail(bothRewrote: boolean, item: RefItem, name: string): string {
  if (bothRewrote) return i18n.t("arena.rewroteConflictDetail", { name });
  return i18n.t("arena.linesConflictDetail", { files: filesNote(item.clash ?? []) });
}

function refStory(item: RefItem): ReviewStory {
  const name = refDisplayName(item.key);
  const lost = item.lost ?? 0;
  const folder = item.checkedOutAt ? folderName(item.checkedOutAt) : undefined;
  const elsewhere = folder
    ? [i18n.t("arena.folderCheckedOut", { folder: folder, name: name })]
    : [];
  const backup = i18n.t("arena.backupRef", { name: name });
  const lists = (item.lost ?? 0) > 0;
  if (overlaps(item)) {
    const bothRewrote = item.agentMove === "rewrote" && item.yourMove === "rewrote";
    const what = bothRewrote
      ? i18n.t("arena.bothRewrote")
      : i18n.t("arena.bothSameLines", { files: filesNote(item.clash ?? []) });
    return {
      title: i18n.t("arena.bothChangedRef", { name: name }),
      note: i18n.t("arena.youAgentNote", { change: what }),
      detail: overlapDetail(bothRewrote, item, name),
      mine: i18n.t("arena.keepMine"),
      winner: i18n.t("arena.useAgents"),
    };
  }
  if (item.agentMove === "deleted") {
    return {
      title: i18n.t("arena.winnerDeletes", { name: name }),
      note: i18n.t("arena.agentDeleted"),
      detail: i18n.t("arena.applyDeletes", { name: name }),
      asides: [backup, ...elsewhere],
      mine: i18n.t("arena.keepSide", { side: name }),
      winner: i18n.t("arena.deleteRef", { name: name }),
    };
  }
  if (item.namespace === "tag") {
    return {
      title: i18n.t("arena.winnerMoves", { name: name }),
      note: i18n.t("arena.agentMoved", { commit: quoted(item.agentSubject) }),
      detail: i18n.t("arena.applyMoves", { name: name, commit: quoted(item.agentSubject) }),
      asides: [backup],
      mine: i18n.t("arena.keepTag"),
      winner: i18n.t("arena.moveTag"),
    };
  }
  if (item.rewound) {
    return {
      title: i18n.t("arena.winnerRewinds", { name: name }),
      note: i18n.t("arena.agentRewound", { commits: commits(lost) }),
      detail: i18n.t("arena.applyRewinds", {
        name: name,
        commit: quoted(item.agentSubject),
        details: lists ? ` ${leavingLead(item, name)}` : "",
      }),
      leaving: leaving(item),
      asides: [backup, ...elsewhere],
      mine: i18n.t("arena.keepRefAsIs", { name: name }),
      winner: i18n.t("arena.moveRefBack", { name: name }),
    };
  }
  if (item.agentMove === "rewrote") {
    let detail = i18n.t("arena.applyHistory", { name: name });
    if (item.proposal === "yours_on_agent") {
      detail = i18n.t("arena.applyHistoryWithYours", { name: name });
    } else if (lists) {
      detail = `${detail} ${leavingLead(item, name)}`;
    }
    return {
      title: i18n.t("arena.winnerRewrites", { name: name }),
      note:
        lost > 0
          ? i18n.t("arena.agentRewritesLost", { commits: commits(lost) })
          : i18n.t("arena.agentRewrote"),
      detail,
      ...(item.proposal === "yours_on_agent" ? {} : { leaving: leaving(item) }),
      asides: [backup, ...elsewhere],
      mine: i18n.t("arena.keepMyRef", { name: name }),
      winner: i18n.t("arena.useAgentRef", { name: name }),
    };
  }
  // A write that removes nothing; it waits only because another worktree has the branch.
  const where = folder ?? i18n.t("arena.anotherWorktree");
  return {
    title: i18n.t("arena.refCheckedElsewhere", { name: name }),
    note: i18n.t("arena.checkedOutAt", { folder: where }),
    detail: i18n.t("arena.applyElsewhere", { name: name, folder: where }),
    mine: i18n.t("arena.leaveRef", { name: name }),
    winner: i18n.t("arena.updateRef", { name: name }),
  };
}

function story(item: Exclude<ArenaReviewItem, BusyItem>): ReviewStory {
  switch (item.kind) {
    case "ref":
      return refStory(item);
    case "occupied": {
      const folder = folderName(item.path);
      return {
        title: i18n.t("arena.refCheckedElsewhere", { name: item.branch }),
        note: i18n.t("arena.winnerEndedElsewhere", { folder: folder }),
        detail: i18n.t("arena.applySwitchElsewhere", { branch: item.branch, folder: folder }),
        mine: i18n.t("arena.stayBranch"),
        winner: i18n.t("arena.switchBranch", { branch: item.branch }),
      };
    }
    case "edits":
      return {
        title: i18n.t("arena.winnerEditsConflict"),
        note: "",
        detail: i18n.t("arena.workspaceChanged"),
        mine: i18n.t("arena.keepChanges"),
        winner: i18n.t("arena.applyWinning"),
      };
  }
}

/** What the rest of the winner does once the question is answered. */
export function readySentence(
  planned: readonly { ref: string }[],
  switchTo: string | undefined,
): string | null {
  const names = planned.map((entry) => refDisplayName(entry.ref));
  const parts: string[] = [];
  if (names.length > 0) {
    parts.push(
      i18n.t(names.length === 1 ? "arena.refGetsCommits" : "arena.refsGetCommits", {
        names: names.join(", "),
      }),
    );
  }
  if (switchTo) {
    parts.push(
      names.length === 1 && names[0] === switchTo
        ? i18n.t("arena.workspaceSwitches")
        : i18n.t("arena.workspaceSwitchesTo", { branch: switchTo }),
    );
  }
  if (parts.length === 0) return null;
  return i18n.t("arena.readyAnswer", {
    changes: parts.reduce((first, last) => i18n.t("arena.listReady", { first, last })),
  });
}

export interface ReviewRow {
  key: string;
  name: string;
  note: string;
}

export interface ReviewCalloutCopy {
  title: string;
  detail: string;
  /** Commits that leave a branch, one bullet each. */
  leaving: readonly string[];
  /** Short lines after the lists: the backup, another worktree, and what waits for the answer. */
  notes: readonly string[];
  files: readonly string[];
  /** Listed only when several questions share the callout; one question names its branch in the title. */
  branches: readonly ReviewRow[];
  /** In order; the first is the emphasised one. `resolve` appears only when there is something to combine. */
  actions: readonly { kind: ReviewMode; label: string }[];
}

function branchRow(item: Exclude<ArenaReviewItem, BusyItem>): ReviewRow[] {
  if (item.kind === "ref")
    return [{ key: item.key, name: refDisplayName(item.key), note: story(item).note }];
  if (item.kind === "occupied")
    return [{ key: item.key, name: item.branch, note: story(item).note }];
  return [];
}

/** The callout for every item but `busy`, which is a wait rather than a choice. */
export function reviewCallout(
  items: readonly ArenaReviewItem[],
  planned: readonly { ref: string }[] = [],
  switchTo?: string,
): ReviewCalloutCopy {
  const questions = items.filter(
    (item): item is Exclude<ArenaReviewItem, BusyItem> => item.kind !== "busy",
  );
  const files = [
    ...new Set(questions.flatMap((item) => (item.kind === "edits" ? item.paths : []))),
  ];
  const ready = readySentence(planned, switchTo);
  const single = questions.length === 1 ? questions[0] : undefined;
  const told = single ? story(single) : undefined;
  const labels: Record<ReviewMode, string> = {
    resolve: i18n.t("arena.letResolve"),
    winner: told?.winner ?? i18n.t("arena.applyWinning"),
    mine: told?.mine ?? i18n.t("arena.keepChanges"),
  };
  // An agent is always on offer, and it is the filled button: it keeps the developer's work and
  // asks before removing any of it.
  const modes: ReviewMode[] = ["resolve", "winner", "mine"];
  return {
    title: told?.title ?? i18n.t("arena.answerNeeded"),
    detail: told?.detail ?? i18n.t("arena.nothingApplied"),
    leaving: told?.leaving ?? [],
    notes: [...(told?.asides ?? []), ...(ready ? [ready] : [])],
    files,
    branches: told ? [] : questions.flatMap(branchRow),
    actions: modes.map((kind) => ({ kind, label: labels[kind] })),
  };
}

function refChoice(item: RefItem, mode: ReviewMode): ArenaBranchAction {
  const has = (choice: ArenaBranchAction) => item.choices.includes(choice);
  if (mode === "mine") return "yours";
  if (mode === "resolve") return has("combine") ? "combine" : "yours";
  // The winner's side: the proposal when it is one, the agent's ref as it stands otherwise.
  if (item.proposal !== "ask_agent" && item.proposal !== "combine" && has(item.proposal))
    return item.proposal;
  return "agent";
}

const EDITS_CHOICE: Record<ReviewMode, "agent" | "yours" | "combine"> = {
  winner: "agent",
  mine: "yours",
  resolve: "combine",
};

/** One answer per item, all from the same button. */
export function reviewAnswers(
  items: readonly ArenaReviewItem[],
  mode: ReviewMode,
): ArenaReviewAnswer[] {
  return items.flatMap((item): ArenaReviewAnswer[] => {
    switch (item.kind) {
      case "ref":
        return [{ key: item.key, fingerprint: item.fingerprint, choice: refChoice(item, mode) }];
      case "edits":
        return [
          {
            key: item.key,
            fingerprint: item.fingerprint,
            choice: EDITS_CHOICE[mode],
          },
        ];
      case "occupied":
        return [
          {
            key: item.key,
            fingerprint: item.fingerprint,
            choice: mode === "mine" ? "stay" : "take",
          },
        ];
      case "busy":
        return [];
    }
  });
}

/**
 * What "Let an agent resolve" sends once the winner is applied with the developer's work kept.
 * The agent runs in this workspace, so it is told not to move the workspace's own branch.
 */
export function resolvePrompt(items: readonly ArenaReviewItem[]): string {
  const lines = items.flatMap((item): string[] => {
    if (item.kind === "edits") {
      const mergeable = item.paths.filter((path) => !item.unmergeable.includes(path));
      return [
        ...(mergeable.length > 0
          ? [`Resolve the conflict markers in ${mergeable.join(", ")}.`]
          : []),
        ...(item.unmergeable.length > 0
          ? [
              `${item.unmergeable.join(", ")} could not hold conflict markers, so my copy was kept. Bring in the winning agent's change there.`,
            ]
          : []),
      ];
    }
    if (item.kind !== "ref") return [];
    const name = refDisplayName(item.key);
    const source = item.agentRef ? ` The winning agent's version is at ${item.agentRef}.` : "";
    if (item.proposal === "combine") {
      return [`Resolve the conflict markers that ${name} now has in this workspace.`];
    }
    if (item.proposal === "ask_agent") {
      return [
        `Combine the winning agent's changes to ${name} with mine, in a temporary worktree for ${name}.${source}`,
      ];
    }
    const lost = item.lost ?? 0;
    const losing = lost > 0 ? `, which takes ${lost} commit${lost === 1 ? "" : "s"} off it` : "";
    if (item.agentMove === "deleted") {
      return [`The winning agent deleted ${name}. I kept it. Tell me if it should go.`];
    }
    if (item.namespace === "tag") {
      return [
        `The winning agent moved ${name}. I kept it where it was.${source} Tell me if it should move.`,
      ];
    }
    if (item.rewound) {
      return [
        `The winning agent moved ${name} back to ${quoted(item.agentSubject)}${losing}. I kept ${name} as it is. Tell me what you think ${name} should point at.`,
      ];
    }
    if (item.agentMove === "rewrote") {
      return [
        `The winning agent rewrote ${name}${losing}. I kept mine.${source} Tell me what differs.`,
      ];
    }
    return [
      `${name} is checked out in ${item.checkedOutAt ?? "another worktree"}, so I left it as it is.${source} Tell me how to bring the agent's commits in without disturbing that worktree.`,
    ];
  });
  return [
    "I applied the winning agent's changes and kept my own work wherever the two differ. Work through the list below, keeping the intent of both sides. Do not switch this workspace's branch, and ask me before you remove any of my commits, branches, tags, or edits.",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}

/** The busy callout: a Git operation in the way is a wait, not a choice. */
export function busyCallout(item: BusyItem) {
  return {
    title: i18n.t("arena.busyTitle", { operation: item.operation }),
    detail: i18n.t("arena.busyHelp", { operation: item.operation }),
    prompt: `A ${item.operation} is in progress in this workspace. Show me where it stands, then finish it. Ask me before you abort it.`,
  };
}

/** What "Let an agent resolve" sends when the winner could not be applied at all. */
export function stoppedPrompt(reason: string | undefined): string {
  const why = reason ? ` Arena said: "${reason}"` : "";
  return `The winning changes from the last battle were not applied to this workspace.${why} Apply them by hand, and keep my own changes.`;
}

export const DISCARD_WINNER_CONFIRMATION: ConfirmDialogInput = {
  get title() {
    return i18n.t("arena.discardWinningTitle");
  },
  get message() {
    return i18n.t("arena.discardWinningHelp");
  },
  get confirmLabel() {
    return i18n.t("arena.discardWinning");
  },
  get cancelLabel() {
    return i18n.t("arena.cancel");
  },
  destructive: true,
};

/**
 * "Let an agent resolve" sends its prompt once the apply its answers started has settled. The
 * answer comes back as soon as Arena claims the apply, which then runs for as long as the checkout
 * takes, so the prompt waits for the turn to say how it ended.
 */
export interface HeldResolvePrompt {
  turnId: string;
  /** The turn's `updatedAt` in the answer; only a later state is the outcome of this apply. */
  claimedAt: string;
  prompt: string;
}

type SettlingTurn = Pick<
  NonNullable<ArenaSnapshot["turn"]>,
  "id" | "state" | "updatedAt" | "gitApplication"
>;

const APPLY_IN_PROGRESS: ReadonlySet<SettlingTurn["state"]> = new Set([
  "applying",
  "canonicalizing",
  "cleanup_pending",
]);

/**
 * Whether a held prompt keeps waiting, goes to the agent, or is dropped. It goes wherever the
 * winner reached the checkout, parked with markers included. A failed apply keeps its error on the
 * callout, and the prompt goes nowhere.
 */
export function heldResolveStep(
  held: HeldResolvePrompt,
  turn: SettlingTurn | undefined,
): "wait" | "send" | "drop" {
  if (!turn) return "wait";
  if (turn.id !== held.turnId) return "drop";
  if (Date.parse(turn.updatedAt) <= Date.parse(held.claimedAt)) return "wait";
  if (APPLY_IN_PROGRESS.has(turn.state)) return "wait";
  if (turn.state === "complete") return "send";
  const applyFailed =
    turn.gitApplication?.state === "failed" || turn.gitApplication?.state === "manual";
  if (turn.state === "application_failed" && !applyFailed) return "send";
  return "drop";
}
