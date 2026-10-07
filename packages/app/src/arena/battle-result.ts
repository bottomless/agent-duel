import type { ArenaHistoryItem, ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";

export function battleWinnerSide(item: ArenaHistoryItem): ArenaSide | undefined {
  return item.vote === "a" || item.vote === "b" ? item.vote : undefined;
}

/** What a stopped contestant pane says in place of the provider's abort. */
export const STOPPED_BY_EARLY_PICK_NOTE = "Stopped when you picked the other agent's result.";

/**
 * The run's error as the pane should show it, beside the stopped note.
 *
 * Arena no longer records the provider's abort on a stopped run, but runs finalized before that
 * still carry it, and the note says the same thing better. Only that line is dropped: a
 * contestant that failed for its own reasons moments before the pick recorded a real error, and
 * hiding it would leave the pane claiming the pick was all that happened.
 */
export function arenaRunErrorToShow(input: {
  error: string | undefined;
  stoppedByEarlyPick: boolean;
}): string | null {
  if (!input.error) return null;
  if (!input.stoppedByEarlyPick) return input.error;
  const kept = input.error.split("\n").filter((line) => !line.includes("MessageAbortedError"));
  return kept.length > 0 ? kept.join("\n") : null;
}

/**
 * Whether this side stopped because the other side was picked early.
 *
 * An early vote is only offered once one side has settled, so it cancels a contestant that is
 * still working and the provider ends that message with an abort. Nothing went wrong, so the
 * pane says what happened rather than showing the abort — see [arena.md](../../../../docs/arena.md).
 */
export function isStoppedByEarlyPick(input: {
  runState: string | undefined;
  side: ArenaSide;
  turn: Pick<ArenaHistoryItem, "selectedEarly" | "appliedSide"> | undefined;
}): boolean {
  if (input.runState !== "stopped") return false;
  if (input.turn?.selectedEarly !== true) return false;
  return input.turn.appliedSide !== undefined && input.turn.appliedSide !== input.side;
}

/**
 * The states between the vote and the resolved battle.
 *
 * The daemon answers a vote as soon as the choice is durable and works through these
 * afterwards, so there is a second or more where the winner is decided, the transcript is not
 * in the chat yet, and the winner's environment is not reported yet. The panes stay up for it
 * — see `isArenaBattleOnScreen` — and the vote footer is what keeps them from reading as
 * frozen.
 */
export const RESOLVING_BATTLE_STATES: ReadonlySet<string> = new Set([
  "early_selected",
  "applying",
  "canonicalizing",
  "cleanup_pending",
]);

export function isResolvingBattleState(state: string | undefined): boolean {
  return state !== undefined && RESOLVING_BATTLE_STATES.has(state);
}

export interface GitApplicationNotice {
  tone: "danger" | "warning" | "info";
  title: string;
  detail: string;
  conflicts: readonly string[];
  conflictsLabel?: string;
}

/** How a ref is named to the user. Mirrors `refLabel` in the arena backend. */
export function refLabel(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return `tag ${ref.slice("refs/tags/".length)}`;
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  return ref;
}

type GitApplication = NonNullable<ArenaHistoryItem["gitApplication"]>;
type RefOutcome = NonNullable<GitApplication["refs"]>[number];
type RefOutcomeAction = RefOutcome["action"];

/** One skip reason can carry git's own error text, which has no length Arena controls. */
const MAX_REASON_LENGTH = 160;

function clampReason(reason: string): string {
  const collapsed = reason.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_REASON_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…`;
}

/**
 * The bar names a count, never the paths.
 *
 * Repo-relative paths are long and comma-joining five of them into one sentence in a one-line
 * strip is unreadable; the battle card lists them as rows instead, where a long path truncates
 * on its own line and the directory disambiguates the tenth `index.js` in the project.
 */
function conflictedFileCount(application: ArenaHistoryItem["gitApplication"]): number {
  return application?.conflicts?.length ?? 0;
}

/**
 * The markers are the gate, so the copy asks for nothing else.
 *
 * The promotion writes its result in one step: a conflicted path is an ordinary dirty file
 * carrying markers, not an unmerged index entry, and no cherry-pick sequencer is left open. The
 * retry reads those paths back, so editing the markers out is the whole of the work — asking for
 * `git add` on top of it would name a step that settles nothing.
 */
export function resolutionRetryDetail(application: ArenaHistoryItem["gitApplication"]): string {
  if (application?.state === "conflicted") {
    const count = conflictedFileCount(application);
    let lead = "Unresolved merge conflicts remain.";
    if (count === 1) lead = "1 file has unresolved merge conflicts.";
    else if (count > 1) lead = `${count} files have unresolved merge conflicts.`;
    const each = count === 1 ? "Resolve it" : "Resolve each one";
    return `${lead} ${each}, then retry.`;
  }
  if (application?.state === "applied") {
    return "The winning Git state is already in this workspace. Retry to finish updating the conversation and environments.";
  }
  return "The winning state is preserved. Retry applying it to this workspace.";
}

export function divergenceFilesLabel(conflicts: readonly string[]): string {
  return `Conflicting files (${conflicts.length})`;
}

/** Keep Git recovery language consistent in the collapsed and expanded battle views. */
export function gitApplicationNotice(item: ArenaHistoryItem): GitApplicationNotice | undefined {
  const application = item.gitApplication;
  if (!application) return;
  if (application.state === "discarded") {
    return {
      tone: "info",
      title: "Winning changes discarded",
      detail: "The winning agent’s changes were not applied.",
      conflicts: [],
    };
  }
  // Edits the merge could not keep were moved aside: the ref holding them is the only way back,
  // so the notice names it, along with anything else the vote wrote.
  if (application.state === "applied" && application.discardedRef) {
    const others = refApplicationNotice(application)?.detail;
    return {
      tone: "info",
      title: "Your changes were set aside",
      detail: `Your uncommitted changes could not be merged with the winning result, so Arena kept them at ${application.discardedRef}: reset --hard ${application.discardedRef}^ returns HEAD, and checkout ${application.discardedRef} -- . returns the files.${others ? ` ${others}` : ""}`,
      conflicts: [],
    };
  }
  // A review, and a promotion that stopped before writing, belong to the callout above the
  // composer, which carries the choices; the card would only repeat it without them.
  if (application.state === "review") return undefined;
  // `conflicted` belongs to the callout above the composer, which reports the same files with the
  // buttons that clear them. The card used to say it too, so a single conflict arrived three
  // times on one screen: a badge on the header, a notice inside the card, and the callout.
  // The refs the winner carried are not in that callout and have nowhere else to go, so they
  // still report here — as the branch notice alone, never as a second copy of the conflict.
  if (application.state === "conflicted") return refApplicationNotice(application);
  if (application.state === "manual" || application.state === "blocked") {
    return {
      tone: "warning",
      title: "Git application needs attention",
      detail:
        application.reason ??
        "The winning result is preserved, but Arena could not apply it automatically to this workspace.",
      conflicts: application.conflicts ?? [],
    };
  }
  if (application.state === "failed") {
    return {
      tone: "danger",
      title: "Git application failed",
      detail: application.reason ?? "Arena could not apply the winning result.",
      conflicts: application.conflicts ?? [],
    };
  }
  return refApplicationNotice(application);
}

function refApplicationNotice(application: GitApplication): GitApplicationNotice | undefined {
  const outcomes = application.refs ?? [];
  const switchedTo = application.switchedTo;
  if (outcomes.length === 0 && !switchedTo) return undefined;
  // Typing verb as a Record over every non-skipped action (rather than casting the lookup)
  // means a fifth `RefOutcome["action"]` fails to compile right here instead of rendering
  // "undefined" to the user.
  const verb: Record<Exclude<RefOutcomeAction, "skipped">, string> = {
    created: "Created",
    updated: "Updated",
    deleted: "Deleted",
  };
  const applied = outcomes.filter(
    (
      outcome,
    ): outcome is RefOutcome & {
      action: Exclude<RefOutcomeAction, "skipped">;
    } => outcome.action !== "skipped",
  );
  const skipped = outcomes.filter((outcome) => outcome.action === "skipped");
  // A skip reason is already a sentence that names its own ref, so it is rendered alone rather
  // than behind another copy of the name. One cause carries git's own message, so clamp it.
  const because = (outcome: { ref: string; reason?: string }) =>
    outcome.reason ? clampReason(outcome.reason) : `${refLabel(outcome.ref)} was not updated.`;
  // A branch both sides changed says how Arena combined them, since it chose without asking.
  const how = (outcome: RefOutcome) => {
    if (outcome.how === "agent_on_yours") return ": the agent’s commits now follow yours";
    if (outcome.how === "yours_on_agent") return ": your commits now follow the agent’s version";
    return "";
  };
  // A write that dropped commits names where they are kept, so the developer can get them back.
  const kept = (outcome: RefOutcome) => {
    if (!outcome.backupRef) return "";
    if (!outcome.removed) return ` Its old value is kept at ${outcome.backupRef}.`;
    const commits = outcome.removed === 1 ? "old commit is" : `${outcome.removed} old commits are`;
    return ` Its ${commits} kept at ${outcome.backupRef}.`;
  };
  const switchedRef = switchedTo ? `refs/heads/${switchedTo}` : undefined;
  const sentences = [
    ...applied.map((outcome) => {
      const here = outcome.ref === switchedRef ? ", and this workspace is now on it" : "";
      return `${verb[outcome.action]} ${refLabel(outcome.ref)}${how(outcome)}${here}.${kept(outcome)}`;
    }),
    ...(switchedTo && !applied.some((outcome) => outcome.ref === switchedRef)
      ? [`This workspace is now on ${switchedTo}.`]
      : []),
    ...skipped.map(because),
  ];
  return {
    tone: skipped.length > 0 ? "warning" : "info",
    title: skipped.length > 0 ? "Some branches were not updated" : "Branches updated",
    detail: sentences.join(" "),
    conflicts: [],
  };
}
