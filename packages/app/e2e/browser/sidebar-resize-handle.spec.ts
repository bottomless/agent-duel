import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

test.use({ viewport: { width: 1600, height: 900 } });

async function expectBorderHighlight(page: Page, testID: string) {
  const handle = page.getByTestId(testID);
  await expect(handle).toBeVisible();
  await expect(page.getByTestId(`${testID}-highlight`)).toHaveCount(0);

  await handle.hover();

  const highlight = page.getByTestId(`${testID}-highlight`);
  await expect(highlight).toBeVisible();
  await expect(highlight).toHaveCSS("width", "1px");
  await expect(highlight).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
}

test("sidebar and side panel borders highlight on hover", async ({ page, withWorkspace }) => {
  const workspace = await withWorkspace({ prefix: "sidebar-resize-handle-" });
  await workspace.navigateTo();

  await expectBorderHighlight(page, "left-sidebar-resize-handle");

  await page.getByTestId("workspace-side-panel-toggle").first().click();
  const handle = page.getByTestId("workspace-side-panel-resize-handle");
  await expect(handle).toBeVisible();
  await expect(page.getByTestId("workspace-side-panel-resize-handle-highlight")).toHaveCount(0);
  await handle.hover();
  await expect(page.getByTestId("workspace-side-panel-resize-handle-highlight")).toBeVisible();
});

test("sidebar and side panel can be resized from the keyboard", async ({ page }) => {
  const workspace = await seedWorkspace({
    repoPrefix: "keyboard-resize-",
    title: "Keyboard resize",
  });
  try {
    await gotoAppShell(page);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible();
    await row.click();
    const sidebar = page.getByTestId("left-sidebar-resize-handle");
    const initialWidth = Number(await sidebar.getAttribute("aria-valuenow"));
    await sidebar.focus();
    await sidebar.press("ArrowRight");
    await expect(sidebar).toHaveAttribute("aria-valuenow", String(initialWidth + 10));
    await sidebar.press("Shift+ArrowLeft");
    await expect(sidebar).toHaveAttribute("aria-valuenow", String(initialWidth - 30));
    await expect(sidebar).toBeFocused();

    await page.getByTestId("workspace-side-panel-toggle").first().click();
    const panel = page.getByTestId("workspace-side-panel-resize-handle");
    await panel.focus();
    await panel.press("Home");
    await expect(panel).toHaveAttribute(
      "aria-valuenow",
      (await panel.getAttribute("aria-valuemin"))!,
    );
    await panel.press("End");
    await expect(panel).toHaveAttribute(
      "aria-valuenow",
      (await panel.getAttribute("aria-valuemax"))!,
    );
    await expect(panel).toBeFocused();
  } finally {
    await workspace.cleanup();
  }
});
