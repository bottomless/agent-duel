import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  addProjectViaDaemon,
  connectNewWorkspaceDaemonClient,
  openNewWorkspaceComposer,
  openStartingRefPicker,
  openNewBranchDialog,
  submitNewBranchName,
  selectBranchInPicker,
  selectNewWorkspaceIsolation,
  selectNewWorkspaceProject,
  submitNewWorkspaceEmpty,
} from "../support/helpers/new-workspace";
import { createTempGitRepo, switchRepoBranchOutsideApp } from "../support/helpers/workspace";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

for (const action of ["submit", "reopen menu"] as const) {
  test(`clears a deleted branch on ${action} without losing the prompt`, async ({ page }) => {
    const client = await connectNewWorkspaceDaemonClient();
    const repo = await createTempGitRepo("deleted-branch-", { branches: ["feature", "main"] });
    const project = await addProjectViaDaemon(client, repo.path);
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, project);
      await selectNewWorkspaceIsolation(page, "local");
      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "feature");
      await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText("feature");
      const prompt = page.getByRole("textbox", { name: "Message agent..." });
      await prompt.fill("Keep this prompt after the branch is deleted");
      switchRepoBranchOutsideApp(repo.path, "main");
      execFileSync("git", ["branch", "-D", "feature"], { cwd: repo.path });
      if (action === "submit") await submitNewWorkspaceEmpty(page);
      else await openStartingRefPicker(page);
      await expect(
        page.getByText("This branch no longer exists. Choose another branch.").first(),
      ).toBeVisible();
      await expect(prompt).toHaveValue("Keep this prompt after the branch is deleted");
      expect(
        (await client.fetchWorkspaces()).entries.filter(
          (entry) => entry.projectId === project.projectId,
        ),
      ).toHaveLength(0);
      await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText("main");
      if (action === "submit") await openStartingRefPicker(page);
      await expect(page.getByTestId("new-workspace-ref-picker-branch-main")).toBeVisible();
      await expect(page.getByTestId("new-workspace-ref-picker-branch-feature")).toHaveCount(0);
    } finally {
      await client.removeProject(project.projectId);
      await client.close();
      await repo.cleanup();
    }
  });
}

test("background reads keep the form usable, pause while hidden, and cannot overwrite another project", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const client = await connectNewWorkspaceDaemonClient();
  const first = await createTempGitRepo("poll-first-", { branches: ["feature", "main"] });
  const second = await createTempGitRepo("poll-second-", { branches: ["second", "main"] });
  switchRepoBranchOutsideApp(second.path, "second");
  const firstProject = await addProjectViaDaemon(client, first.path);
  const secondProject = await addProjectViaDaemon(client, second.path);
  const requests: string[] = [];
  const heldIds = new Set<string>();
  const release: Array<() => void> = [];
  let hold = false;
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const envelope = JSON.parse(message.toString());
      const request = envelope.message;
      if (request?.type === "checkout_status_request" && request.refreshGit) {
        requests.push(request.cwd);
        if (hold && request.cwd === first.path) heldIds.add(request.requestId);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const response = JSON.parse(message.toString()).message;
      if (
        response?.type === "checkout_status_response" &&
        heldIds.has(response.payload.requestId)
      ) {
        release.push(ws.send.bind(ws, message));
      } else ws.send(message);
    });
  });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, firstProject);
    await selectNewWorkspaceIsolation(page, "local");
    const label = page.getByTestId("new-workspace-ref-picker-trigger");
    await expect(label).toContainText("main");
    await expect.poll(() => requests.length).toBeGreaterThan(1);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenCount = requests.length;
    await page.waitForTimeout(2_500);
    expect(requests).toHaveLength(hiddenCount);
    switchRepoBranchOutsideApp(first.path, "feature");
    hold = true;
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => release.length).toBe(1);
    const prompt = page.getByRole("textbox", { name: "Message agent..." });
    await prompt.fill("Typing while Git refresh is pending");
    await expect(
      page.getByTestId("message-input-root").getByRole("button", { name: "Create" }),
    ).toBeEnabled();
    await selectNewWorkspaceProject(page, secondProject);
    await expect(label).toContainText("second");
    hold = false;
    for (const send of release.splice(0)) send();
    await expect(prompt).toHaveValue("Typing while Git refresh is pending");
    await expect(label).toContainText("second");
    const firstCount = requests.filter((cwd) => cwd === first.path).length;
    await expect
      .poll(() => requests.filter((cwd) => cwd === second.path).length)
      .toBeGreaterThan(1);
    expect(requests.filter((cwd) => cwd === first.path)).toHaveLength(firstCount);
    await expect(label).toContainText("second");
    await openStartingRefPicker(page);
    await selectBranchInPicker(page, "second");
    await expect(
      page.getByTestId("message-input-root").getByRole("button", { name: "Create" }),
    ).toBeEnabled();
    const selectedCount = requests.length;
    switchRepoBranchOutsideApp(second.path, "main");
    await page.waitForTimeout(2_500);
    expect(requests).toHaveLength(selectedCount);
    await expect(label).toContainText("second");
  } finally {
    for (const send of release.splice(0)) send();
    await client.removeProject(firstProject.projectId);
    await client.removeProject(secondProject.projectId);
    await client.close();
    await first.cleanup();
    await second.cleanup();
  }
});

test("follows an external branch switch before the project's first chat without opening the menu", async ({
  page,
}) => {
  const client = await connectNewWorkspaceDaemonClient();
  const repo = await createTempGitRepo("follow-checkout-", { branches: ["feature", "main"] });
  const project = await addProjectViaDaemon(client, repo.path);
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await selectNewWorkspaceIsolation(page, "local");
    const label = page.getByTestId("new-workspace-ref-picker-trigger");
    await expect(label).toContainText("main");
    switchRepoBranchOutsideApp(repo.path, "feature");
    await expect(label).toContainText("feature", { timeout: 10_000 });
    await submitNewWorkspaceEmpty(page);
    await expect
      .poll(
        async () =>
          (await client.fetchWorkspaces()).entries.filter(
            (entry) => entry.projectId === project.projectId,
          ).length,
      )
      .toBe(1);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: repo.path,
        encoding: "utf8",
      }).trim(),
    ).toBe("feature");
  } finally {
    await client.removeProject(project.projectId);
    await client.close();
    await repo.cleanup();
  }
});

test("reuses a branch created in Local mode after an external switch", async ({ page }) => {
  const client = await connectNewWorkspaceDaemonClient();
  const repo = await createTempGitRepo("created-branch-", { branches: ["main"] });
  const project = await addProjectViaDaemon(client, repo.path);
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await selectNewWorkspaceIsolation(page, "local");
    await openStartingRefPicker(page);
    await openNewBranchDialog(page, "main");
    await submitNewBranchName(page, "test-branch");
    await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText("test-branch");
    switchRepoBranchOutsideApp(repo.path, "main");
    await submitNewWorkspaceEmpty(page);
    await expect
      .poll(
        async () =>
          (await client.fetchWorkspaces()).entries.filter(
            (entry) => entry.projectId === project.projectId,
          ).length,
      )
      .toBe(1);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: repo.path,
        encoding: "utf8",
      }).trim(),
    ).toBe("test-branch");
  } finally {
    await client.removeProject(project.projectId);
    await client.close();
    await repo.cleanup();
  }
});

test("keeps the prompt when untracked files block a switch and retries from detached HEAD", async ({
  page,
}) => {
  const client = await connectNewWorkspaceDaemonClient();
  const repo = await createTempGitRepo("untracked-detached-", { branches: ["feature", "main"] });
  const project = await addProjectViaDaemon(client, repo.path);
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await selectNewWorkspaceIsolation(page, "local");
    await openStartingRefPicker(page);
    await selectBranchInPicker(page, "main");
    const prompt = page.getByRole("textbox", { name: "Message agent..." });
    await prompt.fill("Keep my prompt");
    switchRepoBranchOutsideApp(repo.path, "feature");
    writeFileSync(join(repo.path, "untracked.txt"), "keep me\n");
    await submitNewWorkspaceEmpty(page);
    await expect(page.getByText(/Working directory has uncommitted changes/).first()).toBeVisible();
    await expect(prompt).toHaveValue("Keep my prompt");
    expect(readFileSync(join(repo.path, "untracked.txt"), "utf8")).toBe("keep me\n");
    expect(
      (await client.fetchWorkspaces()).entries.filter(
        (entry) => entry.projectId === project.projectId,
      ),
    ).toHaveLength(0);
    unlinkSync(join(repo.path, "untracked.txt"));
    execFileSync("git", ["checkout", "--detach"], { cwd: repo.path, stdio: "pipe" });
    // No model call is needed to verify checkout preparation on retry.
    await prompt.fill("");
    await submitNewWorkspaceEmpty(page);
    await expect
      .poll(
        async () =>
          (await client.fetchWorkspaces()).entries.filter(
            (entry) => entry.projectId === project.projectId,
          ).length,
      )
      .toBe(1);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: repo.path,
        encoding: "utf8",
      }).trim(),
    ).toBe("main");
  } finally {
    await client.removeProject(project.projectId);
    await client.close();
    await repo.cleanup();
  }
});

test("keeps the displayed Worktree base after the source branch changes externally", async ({
  page,
}) => {
  const client = await connectNewWorkspaceDaemonClient();
  const repo = await createTempGitRepo("worktree-default-", { branches: ["feature", "main"] });
  const project = await addProjectViaDaemon(client, repo.path);
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await selectNewWorkspaceIsolation(page, "worktree");
    await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText("main");
    switchRepoBranchOutsideApp(repo.path, "feature");
    await submitNewWorkspaceEmpty(page);
    await expect
      .poll(
        async () =>
          (await client.fetchWorkspaces()).entries.filter(
            (entry) => entry.projectId === project.projectId,
          ).length,
      )
      .toBe(1);
    const created = (await client.fetchWorkspaces()).entries.find(
      (entry) => entry.projectId === project.projectId,
    )!;
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: created.workspaceDirectory,
        encoding: "utf8",
      }).trim(),
    ).toBe(repo.branchHeads.main);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: repo.path,
        encoding: "utf8",
      }).trim(),
    ).toBe("feature");
  } finally {
    await client.removeProject(project.projectId);
    await client.close();
    await repo.cleanup();
  }
});

test("honors a selected branch after external switches and refuses an unsafe switch", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const client = await connectNewWorkspaceDaemonClient();
  const repo = await createTempGitRepo("stale-checkout-", { branches: ["dev", "main"] });
  const project = await addProjectViaDaemon(client, repo.path);
  function currentBranch() {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: repo.path,
      encoding: "utf8",
    }).trim();
  }
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await selectNewWorkspaceIsolation(page, "local");
    await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText("main");

    switchRepoBranchOutsideApp(repo.path, "dev");
    await openStartingRefPicker(page);
    await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText("dev");
    // Move after the menu refresh too: the selection must check again.
    switchRepoBranchOutsideApp(repo.path, "main");
    await selectBranchInPicker(page, "dev");
    await expect.poll(currentBranch).toBe("dev");
    await openStartingRefPicker(page);
    await selectBranchInPicker(page, "main");
    await expect.poll(currentBranch).toBe("main");
    await openStartingRefPicker(page);
    switchRepoBranchOutsideApp(repo.path, "dev");
    await selectBranchInPicker(page, "main");
    await expect.poll(currentBranch).toBe("main");

    await page.screenshot({ path: testInfo.outputPath("selected-main.png") });

    switchRepoBranchOutsideApp(repo.path, "dev");
    writeFileSync(join(repo.path, "README.md"), "unsaved local edits\n");
    await submitNewWorkspaceEmpty(page);
    await expect(page.getByText(/Working directory has uncommitted changes/).first()).toBeVisible();
    expect(currentBranch()).toBe("dev");
    expect(
      (await client.fetchWorkspaces()).entries.filter(
        (entry) => entry.projectId === project.projectId,
      ),
    ).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("switch-blocked.png") });

    execFileSync("git", ["restore", "README.md"], { cwd: repo.path });
    await submitNewWorkspaceEmpty(page);
    await expect.poll(currentBranch).toBe("main");
    await expect
      .poll(
        async () =>
          (await client.fetchWorkspaces()).entries.filter(
            (entry) => entry.projectId === project.projectId,
          ).length,
      )
      .toBe(1);
    await page.screenshot({ path: testInfo.outputPath("retry-main.png") });
  } finally {
    await client.removeProject(project.projectId);
    await client.close();
    await repo.cleanup();
  }
});

test("keeps local edits when selecting the branch already checked out", async ({ page }) => {
  const client = await connectNewWorkspaceDaemonClient();
  const repo = await createTempGitRepo("same-branch-dirty-", { branches: ["main"] });
  const project = await addProjectViaDaemon(client, repo.path);
  try {
    writeFileSync(join(repo.path, "README.md"), "keep these local edits\n");
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await selectNewWorkspaceIsolation(page, "local");
    await openStartingRefPicker(page);
    await selectBranchInPicker(page, "main");
    await submitNewWorkspaceEmpty(page);
    await expect
      .poll(
        async () =>
          (await client.fetchWorkspaces()).entries.filter(
            (entry) => entry.projectId === project.projectId,
          ).length,
      )
      .toBe(1);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: repo.path,
        encoding: "utf8",
      }).trim(),
    ).toBe("main");
    expect(readFileSync(join(repo.path, "README.md"), "utf8")).toBe("keep these local edits\n");
  } finally {
    await client.removeProject(project.projectId);
    await client.close();
    await repo.cleanup();
  }
});
