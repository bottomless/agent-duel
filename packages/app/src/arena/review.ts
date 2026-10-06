import type {
  ArenaBranchAction,
  ArenaReviewAnswer,
  ArenaReviewItem,
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
  return rest.length === 0 ? ` in ${first}` : ` in ${first} and ${rest.length} more`;
}

/** Whether the two sides of a ref need combining, rather than one replacing the other. */
function overlaps(item: RefItem): boolean {
  return item.proposal === "ask_agent" || item.proposal === "combine";
}

function commits(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"}`;
}

function quoted(subject: string | undefined): string {
  return subject ? `“${subject}”` : "an older commit";
}

/** Which of the developer's commits would leave the branch, named, so the loss is plain. */
function leaving(item: RefItem): string[] {
  const lost = item.lost ?? 0;
  const subjects = (item.lostSubjects ?? []).toReversed();
  const more = lost - subjects.length;
  return more > 0 ? [...subjects, `and ${more} more`] : subjects;
}

/** The line the bullet list of removed commits hangs from. */
function leavingLead(item: RefItem, name: string): string {
  return (item.lost ?? 0) === 1
    ? `This commit is removed from ${name}:`
    : `These ${commits(item.lost ?? 0)} are removed from ${name}:`;
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

function refStory(item: RefItem): ReviewStory {
  const name = refDisplayName(item.key);
  const lost = item.lost ?? 0;
  const folder = item.checkedOutAt ? folderName(item.checkedOutAt) : undefined;
  const elsewhere = folder
    ? [`${folder} has ${name} checked out. It stays on its current commit.`]
    : [];
  const backup = `Arena keeps a backup of ${name} as it is now, so you can restore it.`;
  const lists = (item.lost ?? 0) > 0;
  if (overlaps(item)) {
    const what =
      item.agentMove === "rewrote" && item.yourMove === "rewrote"
        ? "both rewrote it"
        : `both changed the same lines${filesNote(item.clash ?? [])}`;
    return {
      title: `You and the winner both changed ${name}`,
      note: `you and the agent ${what}`,
      detail: `You and the winning agent ${what.replace(" it", ` ${name}`)}. Git cannot combine the two versions by itself.`,
      mine: "Keep mine",
      winner: "Use the agent’s",
    };
  }
  if (item.agentMove === "deleted") {
    return {
      title: `The winner deletes ${name}`,
      note: "the agent deleted it",
      detail: `If you apply it, ${name} is deleted.`,
      asides: [backup, ...elsewhere],
      mine: `Keep ${name}`,
      winner: `Delete ${name}`,
    };
  }
  if (item.namespace === "tag") {
    return {
      title: `The winner moves ${name}`,
      note: `the agent moved it to ${quoted(item.agentSubject)}`,
      detail: `If you apply it, ${name} points at ${quoted(item.agentSubject)} instead of its current commit.`,
      asides: [backup],
      mine: "Keep the tag where it is",
      winner: "Move the tag",
    };
  }
  if (item.rewound) {
    return {
      title: `The winner moves ${name} back to an older commit`,
      note: `the agent moved it back, which removes ${commits(lost)} from it`,
      detail: `If you apply it, ${name} moves back to ${quoted(item.agentSubject)}.${lists ? ` ${leavingLead(item, name)}` : ""}`,
      leaving: leaving(item),
      asides: [backup, ...elsewhere],
      mine: `Keep ${name} as it is`,
      winner: `Move ${name} back`,
    };
  }
  if (item.agentMove === "rewrote") {
    let detail = `If you apply it, ${name} takes the agent’s history.`;
    if (item.proposal === "yours_on_agent") {
      detail = `If you apply it, ${name} takes the agent’s history with your new commits on top, and the commits the agent rewrote are removed from ${name}.`;
    } else if (lists) {
      detail = `${detail} ${leavingLead(item, name)}`;
    }
    return {
      title: `The winner rewrites ${name}`,
      note:
        lost > 0
          ? `the agent rewrote it, which removes ${commits(lost)} from it`
          : "the agent rewrote it",
      detail,
      ...(item.proposal === "yours_on_agent" ? {} : { leaving: leaving(item) }),
      asides: [backup, ...elsewhere],
      mine: `Keep my ${name}`,
      winner: `Use the agent’s ${name}`,
    };
  }
  // A write that removes nothing; it waits only because another worktree has the branch.
  const where = folder ?? "another worktree";
  return {
    title: `${name} is checked out in another worktree`,
    note: `checked out in ${where}`,
    detail: `If you apply it, ${name} gets the winner’s commits, and ${where} stays on its current commit without the branch.`,
    mine: `Leave ${name} as it is`,
    winner: `Update ${name}`,
  };
}

function story(item: Exclude<ArenaReviewItem, BusyItem>): ReviewStory {
  switch (item.kind) {
    case "ref":
      return refStory(item);
    case "occupied": {
      const folder = folderName(item.path);
      return {
        title: `${item.branch} is checked out in another worktree`,
        note: `the winner ended on it; checked out in ${folder}`,
        detail: `The winner ended on ${item.branch}. If you apply it, this workspace switches to ${item.branch}, and ${folder} stays on its current commit without the branch.`,
        mine: "Stay on this branch",
        winner: `Switch to ${item.branch}`,
      };
    }
    case "edits":
      return {
        title: "The winner conflicts with changes in this workspace",
        note: "",
        detail:
          "This workspace has changes since the battle started, and the winner changes the same lines.",
        mine: "Keep my changes",
        winner: "Apply winning changes",
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
    parts.push(`${names.join(", ")} ${names.length === 1 ? "gets" : "get"} the winner’s commits`);
  }
  if (switchTo) {
    parts.push(
      names.length === 1 && names[0] === switchTo
        ? "this workspace switches to it"
        : `this workspace switches to ${switchTo}`,
    );
  }
  if (parts.length === 0) return null;
  return `Ready once you answer: ${parts.join(", and ")}.`;
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
    resolve: "Let an agent resolve",
    winner: told?.winner ?? "Apply winning changes",
    mine: told?.mine ?? "Keep my changes",
  };
  // An agent is always on offer, and it is the filled button: it keeps the developer's work and
  // asks before removing any of it.
  const modes: ReviewMode[] = ["resolve", "winner", "mine"];
  return {
    title: told?.title ?? "Some of the winner’s changes need your answer",
    detail: told?.detail ?? "Nothing is applied until you answer.",
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
    const losing = lost > 0 ? `, which takes ${commits(lost)} off it` : "";
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
    title: `A ${item.operation} is in progress`,
    detail: `Arena applies the winning changes once the ${item.operation} in this workspace is finished or aborted.`,
    prompt: `A ${item.operation} is in progress in this workspace. Show me where it stands, then finish it. Ask me before you abort it.`,
  };
}

/** What "Let an agent resolve" sends when the winner could not be applied at all. */
export function stoppedPrompt(reason: string | undefined): string {
  const why = reason ? ` Arena said: "${reason}"` : "";
  return `The winning changes from the last battle were not applied to this workspace.${why} Apply them by hand, and keep my own changes.`;
}

export const DISCARD_WINNER_CONFIRMATION: ConfirmDialogInput = {
  title: "Discard winning changes?",
  message:
    "This will discard the winning agent’s work from this battle. Your workspace stays as it is.",
  confirmLabel: "Discard winning changes",
  cancelLabel: "Cancel",
  destructive: true,
};
