import { describe, expect, it } from "vitest";
import type { ArenaReviewItem } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  busyCallout,
  refDisplayName,
  readySentence,
  resolvePrompt,
  reviewAnswers,
  reviewCallout,
  stoppedPrompt,
} from "./review";

const refItem = (input: Partial<Extract<ArenaReviewItem, { kind: "ref" }>> = {}) =>
  ({
    kind: "ref",
    key: "refs/heads/feat/clash",
    fingerprint: "s:a:y:-",
    namespace: "branch",
    agentMove: "added",
    yourMove: "added",
    proposal: "ask_agent",
    choices: ["agent", "yours"],
    checkout: false,
    clash: ["CLASH.md"],
    agentRef: "refs/battles/x/turn-5/a-refs/heads/feat/clash",
    ...input,
  }) satisfies ArenaReviewItem;

const editsItem = (input: Partial<Extract<ArenaReviewItem, { kind: "edits" }>> = {}) =>
  ({
    kind: "edits",
    key: "@edits",
    fingerprint: "NOTES.md",
    paths: ["NOTES.md"],
    unmergeable: [],
    choices: ["combine", "agent", "yours"],
    ...input,
  }) satisfies ArenaReviewItem;

const deletedItem = refItem({
  key: "refs/heads/feat/old",
  agentMove: "deleted",
  yourMove: "untouched",
  proposal: "agent",
  choices: ["agent", "yours"],
  clash: undefined,
  agentRef: undefined,
});

const rewoundItem = refItem({
  key: "refs/heads/main",
  agentMove: "rewrote",
  yourMove: "untouched",
  proposal: "agent",
  choices: ["agent", "yours"],
  clash: undefined,
  agentRef: "refs/battles/x/turn-0/a-refs/heads/main",
  rewound: true,
  lost: 2,
  lostSubjects: ["Add reading time", "Add word count"],
  agentSubject: "Add draft",
});

describe("review callout", () => {
  it("names refs the way a developer types them", () => {
    expect(refDisplayName("refs/heads/feat/x")).toBe("feat/x");
    expect(refDisplayName("refs/tags/v1")).toBe("tag v1");
    expect(refDisplayName("refs/remotes/origin/main")).toBe("origin/main");
  });

  it("says plainly which commits leave a branch the agent moved back", () => {
    const copy = reviewCallout(
      [rewoundItem],
      [{ ref: "refs/heads/feat/writing-studio" }],
      "feat/writing-studio",
    );
    expect(copy.title).toBe("The winner moves main back to an older commit");
    expect(copy.detail).toBe(
      "If you apply it, main moves back to “Add draft”. These 2 commits are removed from main:",
    );
    expect(copy.leaving).toEqual(["Add word count", "Add reading time"]);
    expect(copy.notes).toEqual([
      "Arena keeps a backup of main as it is now, so you can restore it.",
      "Ready once you answer: feat/writing-studio gets the winner’s commits, and this workspace switches to it.",
    ]);
    expect(copy.branches).toEqual([]);
    expect(copy.actions.map((action) => action.label)).toEqual([
      "Let an agent resolve",
      "Move main back",
      "Keep main as it is",
    ]);
  });

  it("names a deleted branch in the title and the buttons", () => {
    const copy = reviewCallout([deletedItem]);
    expect(copy.title).toBe("The winner deletes feat/old");
    expect(copy.detail).toBe("If you apply it, feat/old is deleted.");
    expect(copy.notes).toEqual([
      "Arena keeps a backup of feat/old as it is now, so you can restore it.",
    ]);
    expect(copy.actions.map((action) => action.label)).toEqual([
      "Let an agent resolve",
      "Delete feat/old",
      "Keep feat/old",
    ]);
  });

  it("keeps main's title and buttons for files alone", () => {
    const copy = reviewCallout([editsItem()]);
    expect(copy.title).toBe("The winner conflicts with changes in this workspace");
    expect(copy.files).toEqual(["NOTES.md"]);
    expect(copy.actions.map((action) => action.label)).toEqual([
      "Let an agent resolve",
      "Apply winning changes",
      "Keep my changes",
    ]);
  });

  it("lists several questions with a few words each", () => {
    const copy = reviewCallout([refItem(), deletedItem, rewoundItem, editsItem()]);
    expect(copy.title).toBe("Some of the winner’s changes need your answer");
    expect(copy.detail).toBe("Nothing is applied until you answer.");
    expect(copy.files).toEqual(["NOTES.md"]);
    expect(copy.branches.map((row) => `${row.name}: ${row.note}`)).toEqual([
      "feat/clash: you and the agent both changed the same lines in CLASH.md",
      "feat/old: the agent deleted it",
      "main: the agent moved it back, which removes 2 commits from it",
    ]);
  });

  it("counts the commits it cannot name", () => {
    const copy = reviewCallout([{ ...rewoundItem, lost: 5 }]);
    expect(copy.leaving).toEqual(["Add word count", "Add reading time", "and 3 more"]);
  });

  it("says what waits for the answer", () => {
    expect(readySentence([], undefined)).toBeNull();
    expect(readySentence([{ ref: "refs/heads/a" }, { ref: "refs/heads/b" }], "c")).toBe(
      "Ready once you answer: a, b get the winner’s commits, and this workspace switches to c.",
    );
  });

  it("answers every item from one button, and the agent never removes anything", () => {
    const items = [refItem(), deletedItem, rewoundItem, editsItem()];
    expect(reviewAnswers(items, "winner").map((answer) => answer.choice)).toEqual([
      "agent",
      "agent",
      "agent",
      "agent",
    ]);
    expect(reviewAnswers(items, "mine").map((answer) => answer.choice)).toEqual([
      "yours",
      "yours",
      "yours",
      "yours",
    ]);
    expect(reviewAnswers(items, "resolve").map((answer) => answer.choice)).toEqual([
      "yours",
      "yours",
      "yours",
      "combine",
    ]);
    const checkout = refItem({
      checkout: true,
      proposal: "combine",
      choices: ["combine", "agent", "yours"],
    });
    expect(reviewAnswers([checkout], "resolve")[0]?.choice).toBe("combine");
    const rewrite = refItem({
      agentMove: "rewrote",
      proposal: "yours_on_agent",
      choices: ["yours_on_agent", "agent", "yours"],
    });
    expect(reviewAnswers([rewrite], "winner")[0]?.choice).toBe("yours_on_agent");
  });

  it("hands the agent every question and tells it to ask before removing work", () => {
    const prompt = resolvePrompt([
      refItem(),
      deletedItem,
      rewoundItem,
      editsItem({ paths: ["NOTES.md", "logo.png"], unmergeable: ["logo.png"] }),
    ]);
    expect(prompt).toContain(
      "ask me before you remove any of my commits, branches, tags, or edits.",
    );
    expect(prompt).toContain(
      "- Combine the winning agent's changes to feat/clash with mine, in a temporary worktree for feat/clash.",
    );
    expect(prompt).toContain(
      "- The winning agent deleted feat/old. I kept it. Tell me if it should go.",
    );
    expect(prompt).toContain(
      "- The winning agent moved main back to “Add draft”, which takes 2 commits off it. I kept main as it is.",
    );
    expect(prompt).toContain("- Resolve the conflict markers in NOTES.md.");
    expect(prompt).toContain("- logo.png could not hold conflict markers");
  });

  it("keeps a Git operation in progress as a wait", () => {
    const copy = busyCallout({
      kind: "busy",
      key: "@busy",
      fingerprint: "rebase",
      operation: "rebase",
    });
    expect(copy.title).toBe("A rebase is in progress");
    expect(copy.prompt).toContain("Ask me before you abort it.");
  });

  it("quotes Arena's reason when an agent applies a stopped winner", () => {
    expect(stoppedPrompt("The winner moved.")).toContain('Arena said: "The winner moved."');
  });
});
