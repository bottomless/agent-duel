import { describe, expect, it } from "vitest";
import type { ProjectGitState } from "@getpaseo/protocol/messages";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";
import { type BattleRepositoryClient, ensureBattleRepository } from "./battle-repository";

function createClient(input: {
  state: ProjectGitState | null;
  inspectError?: string;
  initializeError?: string;
}) {
  const calls: string[] = [];
  const client: BattleRepositoryClient = {
    async inspectProjectGit(cwd) {
      calls.push(`inspect:${cwd}`);
      return { state: input.state, error: input.inspectError ?? null };
    },
    async initializeProjectGit(cwd) {
      calls.push(`initialize:${cwd}`);
      return { error: input.initializeError ?? null };
    },
  };
  return { client, calls };
}

function recordConfirm(answer: boolean) {
  const dialogs: ConfirmDialogInput[] = [];
  return {
    dialogs,
    confirm: async (dialog: ConfirmDialogInput) => {
      dialogs.push(dialog);
      return answer;
    },
  };
}

describe("ensureBattleRepository", () => {
  it("does not ask when the folder already has a commit", async () => {
    const { client, calls } = createClient({ state: "ready" });
    const { dialogs, confirm } = recordConfirm(true);

    await ensureBattleRepository({ client, cwd: "/repo", confirm });

    expect(calls).toEqual(["inspect:/repo"]);
    expect(dialogs).toEqual([]);
  });

  it.each([
    ["not_git", "Create a Git repository with an empty first commit?"],
    ["no_commit", "Create an empty first commit?"],
  ] as const)("asks before creating the first commit for %s", async (state, explanation) => {
    const { client, calls } = createClient({ state });
    const { dialogs, confirm } = recordConfirm(true);

    await ensureBattleRepository({ client, cwd: "/folder", confirm });

    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toMatchObject({
      title: "Agent Duel needs a commit",
      confirmLabel: "Create commit",
      cancelLabel: "Cancel",
    });
    expect(dialogs[0]?.message).toBe(explanation);
    expect(calls).toEqual(["inspect:/folder", "initialize:/folder"]);
  });

  it("refuses the battle without touching the folder when the user cancels", async () => {
    const { client, calls } = createClient({ state: "not_git" });
    const { confirm } = recordConfirm(false);

    await expect(ensureBattleRepository({ client, cwd: "/folder", confirm })).rejects.toThrow(
      /^A battle needs a Git commit\.$/,
    );
    expect(calls).toEqual(["inspect:/folder"]);
  });

  it("reports a failed initialization", async () => {
    const { client } = createClient({ state: "no_commit", initializeError: "disk full" });
    const { confirm } = recordConfirm(true);

    await expect(ensureBattleRepository({ client, cwd: "/folder", confirm })).rejects.toThrow(
      "Could not create the first commit: disk full",
    );
  });

  it("reports a failed inspection without asking", async () => {
    const { client } = createClient({ state: null, inspectError: "no such directory" });
    const { dialogs, confirm } = recordConfirm(true);

    await expect(ensureBattleRepository({ client, cwd: "/gone", confirm })).rejects.toThrow(
      "Could not check the folder's Git state: no such directory",
    );
    expect(dialogs).toEqual([]);
  });
});
