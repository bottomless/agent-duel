import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function openSingleAgentDraft(page: Page, workspace: SeededWorkspace): Promise<void> {
  await gotoAppShell(page);
  if ((page.viewportSize()?.width ?? 1280) > 700) {
    await waitForSidebarHydration(page);
  }
  await openGlobalNewWorkspaceComposer(page);
  await selectNewWorkspaceProject(page, {
    projectKey: workspace.projectKey,
    projectDisplayName: workspace.projectDisplayName,
  });

  await expect(page.getByTestId("arena-battle-toggle")).toBeVisible({ timeout: 30_000 });
}

async function enterSingleAgentMode(page: Page): Promise<void> {
  const battleToggle = page.getByTestId("arena-battle-toggle");
  await expect(battleToggle).toHaveAttribute("aria-checked", "true");
  await battleToggle.click();
  await expect(battleToggle).toHaveAttribute("aria-checked", "false");
}

async function openSizePicker(page: Page): Promise<void> {
  const trigger = page.getByTestId("arena-single-agent-size-trigger");
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  await expect(page.getByTestId("arena-single-agent-size-medium")).toBeVisible();
  await expect(page.getByTestId("arena-single-agent-size-frontier")).toBeVisible();
}

async function expectSizeDescriptions(page: Page): Promise<void> {
  await expect(page.getByTestId("arena-single-agent-size-medium")).toContainText(
    "GPT Luna 5.6 Xhigh · Unlimited use",
  );
  await expect(page.getByTestId("arena-single-agent-size-frontier")).toContainText(
    "Model hidden · Rating required",
  );
}

async function expectNoModelDescriptionInComposer(page: Page): Promise<void> {
  await expect(page.getByText("GPT Luna 5.6 Xhigh · Unlimited use", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Model hidden · Rating required", { exact: true })).toHaveCount(0);
}

test.describe("Single-agent model size picker", () => {
  test.describe.configure({ timeout: 180_000 });

  test("defaults to Medium, explains frontier ratings, and keeps the choice across Battle mode", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "single-agent-model-size-" });

    try {
      await openSingleAgentDraft(page, workspace);
      await enterSingleAgentMode(page);

      const sizeTrigger = page.getByTestId("arena-single-agent-size-trigger");
      await expect(sizeTrigger).toHaveAttribute("aria-label", "Model size: medium");
      await expectNoModelDescriptionInComposer(page);

      await openSizePicker(page);
      await expectSizeDescriptions(page);
      await page.screenshot({
        path: testInfo.outputPath("single-agent-medium.png"),
        fullPage: false,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");

      await openSizePicker(page);
      await page.getByTestId("arena-single-agent-size-frontier").click();
      await expect(sizeTrigger).toHaveAttribute("aria-label", "Model size: frontier");
      await expectNoModelDescriptionInComposer(page);

      await openSizePicker(page);
      await expectSizeDescriptions(page);
      await page.screenshot({
        path: testInfo.outputPath("single-agent-frontier.png"),
        fullPage: false,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");

      await page.getByTestId("arena-single-agent-help").click();
      await expect(
        page.getByText(
          "Medium uses GPT Luna 5.6 Xhigh and can be used unlimitedly without a rating.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByText(
          "With frontier, the model stays hidden until you rate it. After the agent finishes, you must give a thumbs up or thumbs down to continue. Chat controls stay disabled until your rating is saved.",
          { exact: true },
        ),
      ).toBeVisible();
      await page.keyboard.press("Escape");

      const battleToggle = page.getByTestId("arena-battle-toggle");
      await battleToggle.click();
      await expect(battleToggle).toHaveAttribute("aria-checked", "true");
      await battleToggle.click();
      await expect(battleToggle).toHaveAttribute("aria-checked", "false");
      await expect(sizeTrigger).toHaveAttribute("aria-label", "Model size: frontier");
      await expectNoModelDescriptionInComposer(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("keeps the picker usable at compact width", async ({ page }) => {
    await page.setViewportSize({ width: 650, height: 844 });
    const workspace = await seedWorkspace({ repoPrefix: "single-agent-model-size-compact-" });

    try {
      await openSingleAgentDraft(page, workspace);
      await enterSingleAgentMode(page);
      await openSizePicker(page);
      await expectSizeDescriptions(page);

      await page.getByTestId("arena-single-agent-size-frontier").click();
      await expect(page.getByTestId("arena-single-agent-size-trigger")).toHaveAttribute(
        "aria-label",
        "Model size: frontier",
      );
      await expectNoModelDescriptionInComposer(page);
    } finally {
      await workspace.cleanup();
    }
  });
});
