import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  connectWorkspaceSetupClient,
  seedProjectForWorkspaceSetup,
} from "../support/helpers/workspace-setup";
import { createTempGitRepo } from "../support/helpers/workspace";

test.describe("Home screen routing", () => {
  test("shows Add a project when no projects exist", async ({ page }) => {
    await gotoAppShell(page);

    await expect(page).toHaveURL(/\/open-project$/, { timeout: 30_000 });
    await expect(page.getByTestId("open-project-submit")).toBeVisible();
    await expect(page.getByTestId("open-project-submit")).toContainText("Add a project");
    await expect(page.locator('[data-testid="message-input-root"]:visible')).toHaveCount(0);
  });

  test("shows the composer when a project exists without a workspace", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("home-composer-");

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const gate = await installDaemonWebSocketGate(page);
      gate.holdNextClientRequest("fetch_workspaces_request");
      await gotoAppShell(page);

      await gate.waitForHeldClientRequest();
      try {
        await expect(page.getByTestId("open-project-submit")).toHaveCount(0);
        await expect(page.locator('[data-testid="message-input-root"]:visible')).toHaveCount(0);
      } finally {
        gate.releaseHeldClientRequest();
      }

      await expect(page).toHaveURL(/\/new(?:\?|$)/, { timeout: 30_000 });
      await expect(page.locator('[data-testid="message-input-root"]:visible')).toBeVisible();
      await expect(page.getByTestId("open-project-submit")).toHaveCount(0);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
