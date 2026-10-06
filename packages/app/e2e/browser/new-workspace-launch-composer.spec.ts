import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectNewWorkspaceDraft,
  fillNewWorkspaceDraft,
  openNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.describe("New workspace composer chrome", () => {
  let workspace: SeededWorkspace;

  test.beforeEach(async () => {
    workspace = await seedWorkspace({ repoPrefix: "launch-composer-" });
  });

  test.afterEach(async () => {
    await workspace?.cleanup();
  });

  test("starts directly in chat without a title or launch-target dropdown", async ({ page }) => {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await openNewWorkspaceComposer(page, {
      projectKey: workspace.projectKey,
      projectDisplayName: workspace.projectDisplayName,
    });

    const composer = page.locator('[data-testid="message-input-root"]:visible');
    await expect(page.getByText("New workspace", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("new-workspace-launch-trigger")).toHaveCount(0);
    await expect(composer.getByTestId("message-input-attach-button")).toBeVisible();
    await expect(composer.getByTestId("workspace-create-submit")).toBeVisible();

    await fillNewWorkspaceDraft(page, "a chat draft");
    await expectNewWorkspaceDraft(page, "a chat draft");
  });
});
