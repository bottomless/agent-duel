import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { metroTest as test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  createIdleAgent,
  expectArchivedChatVisible,
  openArchived,
} from "../support/helpers/archive-tab";
import { buildCreateAgentPreferences, buildSeededHost } from "../support/helpers/daemon-registry";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function readArchivedPlacement(
  client: Awaited<ReturnType<typeof connectSeedClient>>,
  agentId: string,
): Promise<{ branch: string | null; workspace: string | null }> {
  const history = await client.fetchAgentHistory({ archivedOnly: true, page: { limit: 200 } });
  const entry = history.entries.find((candidate) => candidate.agent.id === agentId);
  return {
    branch: entry?.project.checkout.currentBranch ?? null,
    workspace: entry?.project.workspaceName ?? null,
  };
}

test.describe("Worktree restore after daemon restart", () => {
  const serverId = `srv_worktree_restart_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let daemon: IsolatedHostDaemon;
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let worktreeClient: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();
  const createdProjectIds = new Set<string>();

  test.describe.configure({ retries: 0, timeout: 180_000 });

  test.beforeEach(async () => {
    daemon = await startIsolatedHostDaemon(serverId);
    client = await connectSeedClient({ port: daemon.port });
    worktreeClient = await connectNewWorkspaceDaemonClient({
      port: daemon.port,
      ownProjects: false,
    });
    tempRepo = await createTempGitRepo("wt-restart-");
  });

  test.afterEach(async () => {
    for (const directory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(worktreeClient, directory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    for (const projectId of createdProjectIds) {
      await worktreeClient.removeProject(projectId).catch(() => undefined);
    }
    createdProjectIds.clear();
    await client?.close().catch(() => undefined);
    await worktreeClient?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
  });

  async function seedBrowser(page: Page) {
    const nowIso = new Date().toISOString();
    await page.addInitScript(
      ({ host, preferences }) => {
        localStorage.setItem("@paseo:e2e", "1");
        localStorage.setItem("@paseo:daemon-registry", JSON.stringify([host]));
        localStorage.removeItem("@paseo:settings");
        localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
      },
      {
        host: buildSeededHost({
          serverId,
          endpoint: `127.0.0.1:${daemon.port}`,
          label: "restart daemon",
          nowIso,
        }),
        preferences: buildCreateAgentPreferences(serverId),
      },
    );
  }

  test("after archiving a worktree and restarting the daemon, the archived chat keeps the worktree branch (not main) before any restore", async ({
    page,
  }) => {
    // A paseo worktree is cut on its own branch named after the slug, and the
    // worktree workspace is displayed under the same name. These are the values
    // the archived chat's placement must carry after the restart — never "main".
    const worktreeSlug = `restart-restore-${randomUUID().slice(0, 8)}`;

    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    const worktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: worktreeSlug,
    });
    createdProjectIds.add(worktree.projectKey);
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    const agent = await createIdleAgent(client, {
      cwd: worktree.workspaceDirectory,
      workspaceId: worktree.workspaceId,
      title: `restart-restore-${randomUUID().slice(0, 8)}`,
    });
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    // Archive through the default production path (no scope): the worktree dir is deleted.
    await archiveWorkspaceFromDaemon(worktreeClient, worktree.workspaceDirectory);
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);

    // Restart this spec's daemon on the same home and port so it rebuilds all
    // workspace/agent links from persisted state without replacing the shared
    // Playwright daemon owned by global setup.
    await client.close().catch(() => undefined);
    await worktreeClient.close().catch(() => undefined);
    await daemon.restart();
    client = await connectSeedClient({ port: daemon.port });
    worktreeClient = await connectNewWorkspaceDaemonClient({
      port: daemon.port,
      ownProjects: false,
    });

    await seedBrowser(page);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openArchived(page);
    await expectArchivedChatVisible(page, agent.title);

    // KEY ASSERTION: right after the daemon restart, with NO restore and NO row
    // click, the placement the Archived row and its search read from
    // fetch_agent_history must be the worktree branch and the worktree workspace
    // name — never "main".
    await expect
      .poll(() => readArchivedPlacement(client, agent.id), { timeout: 60_000 })
      .toEqual({ branch: worktreeSlug, workspace: worktree.workspaceName });
  });
});
