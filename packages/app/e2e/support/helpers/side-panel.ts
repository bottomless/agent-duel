import { expect, type Page } from "@playwright/test";

export type SidePanelSurface = "changes" | "files" | "pull-request";

/**
 * Opens one of the side panel's own surfaces (Changes, Files, the pull
 * request) as a tab and leaves it focused.
 *
 * Reveal the side panel through the header toggle when it is hidden, then pick
 * the surface from the launcher an empty side pane shows, or from the side
 * pane's "+" menu when it already holds tabs. The same on compact widths, where
 * the open panel takes the whole width.
 */
export async function openSidePanelTab(page: Page, surface: SidePanelSurface): Promise<void> {
  const toggle = page.getByTestId("workspace-side-panel-toggle").first();
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  const expanded = await toggle.getAttribute("aria-expanded");
  if (expanded === "false") {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
  }

  const launcher = page.getByTestId(`workspace-side-panel-launcher-${surface}`);
  if (await launcher.isVisible().catch(() => false)) {
    await launcher.click();
    return;
  }
  await page.getByTestId("workspace-side-panel-new-tab-menu-trigger").click();
  await page.getByTestId(`workspace-side-panel-menu-${surface}`).click();
}

export function sidePanelTab(page: Page, kind: "changes" | "files" | "pull_request") {
  return page.getByTestId(`workspace-tab-${kind}`).first();
}
