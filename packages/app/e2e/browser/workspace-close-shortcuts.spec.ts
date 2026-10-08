import { devices } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { composerLocator } from "../support/helpers/composer";
import { openFileExplorer } from "../support/helpers/file-explorer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { sidePanelTab } from "../support/helpers/side-panel";

test.use({
  userAgent: devices["Desktop Chrome"].userAgent.replace(
    "Windows NT 10.0; Win64; x64",
    "Macintosh; Intel Mac OS X 10_15_7",
  ),
});

for (const placement of ["right", "bottom"] as const) {
  for (const shortcut of ["Alt+Shift+W", "Meta+Shift+W"]) {
    test(`${shortcut} preserves the timeline and closes the ${placement} panel's tabs`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.addInitScript((sidePanelPlacement) => {
        localStorage.setItem("@paseo:app-settings", JSON.stringify({ sidePanelPlacement }));
      }, placement);
      const session = await seedMockAgentWorkspace({
        repoPrefix: "close-shortcuts-",
        title: "Keep this timeline",
        initialPrompt:
          "Generate a title and a git branch name for a coding agent from the user prompt and attachments. Return JSON only with fields 'title' and 'branch'.",
      });
      const dialogs: string[] = [];
      page.on("dialog", async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.accept();
      });

      try {
        await openAgentRoute(page, session);
        const timelineMessage = page.getByTestId("assistant-message").first();
        await expect(timelineMessage).toBeVisible({ timeout: 30_000 });
        await openFileExplorer(page);
        const filesTab = sidePanelTab(page, "files");
        await composerLocator(page).click();
        await page.keyboard.press(shortcut);
        await expect(timelineMessage).toBeVisible();
        await expect(filesTab).toBeVisible();
        expect(dialogs).toEqual([]);

        await filesTab.click();
        await page.keyboard.press(shortcut);
        await expect(filesTab).toHaveCount(0);
        await expect(timelineMessage).toBeVisible();
        await expect(page.getByTestId("workspace-side-panel-launcher-files")).toBeVisible();
      } finally {
        await session.cleanup();
      }
    });
  }
}
