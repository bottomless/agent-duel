import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  submitNewWorkspaceEmpty,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.describe("New workspace isolation", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    await client?.close().catch(() => undefined);
  });

  for (const battleMode of [true, false]) {
    test(`creates a distinct worktree with Battle ${battleMode ? "on" : "off"}`, async ({
      page,
    }) => {
      const seeded: SeededWorkspace = await seedWorkspace({
        repoPrefix: `new-worktree-battle-${battleMode ? "on" : "off"}-`,
      });

      try {
        await gotoAppShell(page);
        await waitForSidebarHydration(page);
        await openGlobalNewWorkspaceComposer(page);
        await selectNewWorkspaceProject(page, {
          projectKey: seeded.projectKey,
          projectDisplayName: seeded.projectDisplayName,
        });

        await expect(page.getByTestId("workspace-create-isolation-trigger")).toHaveCount(0);
        const battleToggle = page.getByTestId("arena-battle-toggle");
        await expect(battleToggle).toHaveAttribute("aria-checked", "true");
        if (!battleMode) {
          await battleToggle.click();
          await expect(battleToggle).toHaveAttribute("aria-checked", "false");
        }

        await submitNewWorkspaceEmpty(page);
        const created = await assertNewWorkspaceSidebarAndHeader(page, {
          serverId: getServerId(),
          client,
          previousWorkspaceId: seeded.workspaceId,
          projectDisplayName: seeded.projectDisplayName,
          assertSidebarRow: false,
          assertHeader: false,
        });

        expect(created.workspaceId).not.toBe(seeded.workspaceId);
        expect(created.workspaceDirectory).not.toBe(seeded.workspaceDirectory);
        const descriptor = (await client.fetchWorkspaces()).entries.find(
          (entry) => entry.id === created.workspaceId,
        );
        expect(descriptor?.workspaceKind).toBe("worktree");

        await client
          .archivePaseoWorktree({ worktreePath: created.workspaceDirectory })
          .catch(() => undefined);
      } finally {
        await seeded.cleanup();
      }
    });
  }
});
