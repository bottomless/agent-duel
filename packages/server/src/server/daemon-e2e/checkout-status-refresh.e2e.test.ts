import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createDaemonTestContext } from "../test-utils/index.js";

test("refreshes an unobserved checkout after an external branch switch", async () => {
  const ctx = await createDaemonTestContext();
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "checkout-status-refresh-")));
  function git(...args: string[]) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  }

  try {
    git("init", "-b", "main");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Initial",
    );
    expect(await ctx.client.getCheckoutStatus(cwd, { refreshGit: true })).toMatchObject({
      currentBranch: "main",
      isDirty: false,
      error: null,
    });

    git("switch", "-c", "other");
    expect(
      await ctx.client.validateBranch({ cwd, branchName: "other", refreshGit: true }),
    ).toMatchObject({ exists: true, error: null });
    expect((await ctx.client.getBranchSuggestions({ cwd, refreshGit: true })).branches).toContain(
      "other",
    );
    writeFileSync(join(cwd, "local.txt"), "keep this\n");
    expect(await ctx.client.getCheckoutStatus(cwd, { refreshGit: true })).toMatchObject({
      currentBranch: "other",
      isDirty: true,
      error: null,
    });

    git("checkout", "--detach");
    expect(await ctx.client.getCheckoutStatus(cwd, { refreshGit: true })).toMatchObject({
      currentBranch: null,
      isDirty: true,
      error: null,
    });
    git("branch", "-D", "other");
    expect(
      await ctx.client.validateBranch({ cwd, branchName: "other", refreshGit: true }),
    ).toMatchObject({ exists: false, error: null });
    expect(
      (await ctx.client.getBranchSuggestions({ cwd, refreshGit: true })).branches,
    ).not.toContain("other");
  } finally {
    await ctx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);
