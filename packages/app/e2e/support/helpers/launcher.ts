import { expect, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../../src/utils/host-routes";
import { createTempGitRepo } from "./workspace";
import { getServerId } from "./server-id";

// ─── Navigation ────────────────────────────────────────────────────────────

/** Navigate to a workspace and wait for the tab bar to appear. */
export async function gotoWorkspace(page: Page, workspaceId: string): Promise<void> {
  const route = buildHostWorkspaceRoute(getServerId(), workspaceId);
  await page.goto(route);
  await waitForTabBar(page);
}

// ─── Tab bar queries ───────────────────────────────────────────────────────

/**
 * Wait for the side panel to have rendered: its tab row, or the launcher an
 * empty side pane shows in place of one. An empty pane draws no tab row, so
 * waiting on the row alone would hang on a freshly opened workspace.
 */
export async function waitForTabBar(page: Page): Promise<void> {
  await expect(
    page
      .getByTestId("workspace-tabs-row")
      .or(page.getByTestId("workspace-side-panel-launcher"))
      .filter({ visible: true })
      .first(),
  ).toBeVisible({
    timeout: 30_000,
  });
}

/** Return all tab test IDs currently in the tab bar. */
export async function getTabTestIds(page: Page): Promise<string[]> {
  const tabs = page
    .locator('[data-testid^="workspace-tab-"]:not([data-testid^="workspace-tab-context-"])')
    .filter({ visible: true });
  const count = await tabs.count();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const testId = await tabs.nth(i).getAttribute("data-testid");
    if (testId) ids.push(testId);
  }
  return ids;
}

/** Return the number of tabs matching a kind prefix (e.g. "launcher", "draft", "terminal", "agent"). */
export async function countTabsOfKind(page: Page, kind: string): Promise<number> {
  const ids = await getTabTestIds(page);
  return ids.filter((id) => id.includes(kind)).length;
}

/** Return the currently active tab's test ID (the one with aria-selected or focus styling). */
export async function getActiveTabTestId(page: Page): Promise<string | null> {
  // Active tab has the focused highlight — check for the aria-selected or data-active attribute
  const activeTab = page
    .locator(
      '[data-testid^="workspace-tab-"]:not([data-testid^="workspace-tab-context-"])[aria-selected="true"]',
    )
    .filter({ visible: true })
    .first();
  if (await activeTab.isVisible().catch(() => false)) {
    return activeTab.getAttribute("data-testid");
  }
  // Fallback: the tab with focused styling
  return null;
}

// ─── Chat and side panel actions ──────────────────────────────────────────

/**
 * Wait for the workspace's chat composer. A workspace holds one chat: an empty
 * workspace seeds a draft on open, so there is nothing to click to get one.
 */
export async function clickNewChat(page: Page): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
  await expect(composer).toBeVisible({ timeout: 10_000 });
}

/** Reveal the side panel if it is hidden. */
export async function revealSidePanel(page: Page): Promise<void> {
  const toggle = page.getByTestId("workspace-side-panel-toggle").filter({ visible: true }).first();
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
  }
}

/**
 * Open the side panel's "+" menu, revealing the panel first if it is hidden.
 * Only an occupied side pane has one: an empty pane draws the launcher instead,
 * so prefer `clickNewTerminal`, which takes whichever surface is present.
 */
export async function openSidePanelNewTabMenu(page: Page): Promise<void> {
  await revealSidePanel(page);
  const trigger = page
    .getByTestId("workspace-side-panel-new-tab-menu-trigger")
    .filter({ visible: true })
    .first();
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
}

/** Start a terminal in the side panel, through the launcher or the "+" menu. */
export async function clickNewTerminal(page: Page): Promise<void> {
  await revealSidePanel(page);
  const launcherEntry = page
    .getByTestId("workspace-side-panel-launcher-terminal")
    .filter({ visible: true })
    .first();
  if (await launcherEntry.isVisible().catch(() => false)) {
    await launcherEntry.click();
    return;
  }
  await openSidePanelNewTabMenu(page);
  const item = page
    .getByTestId("workspace-side-panel-menu-terminal")
    .filter({ visible: true })
    .first();
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
}

// ─── Tab title assertions ──────────────────────────────────────────────────

/** Wait for any tab in the bar to display the given title text. */
export async function waitForTabWithTitle(
  page: Page,
  title: string | RegExp,
  timeout = 30_000,
): Promise<void> {
  const matcher = typeof title === "string" ? new RegExp(title, "i") : title;
  await expect(
    page
      .locator('[data-testid^="workspace-tab-"]:not([data-testid^="workspace-tab-context-"])')
      .filter({ hasText: matcher })
      .filter({ visible: true })
      .first(),
  ).toBeVisible({ timeout });
}

// ─── No-flash measurement ──────────────────────────────────────────────────

/**
 * Measure the time between clicking a launcher tile and the replacement panel becoming visible.
 * Returns elapsed milliseconds.
 */
export async function measureTileTransition(
  page: Page,
  clickAction: () => Promise<void>,
  successLocator: ReturnType<Page["locator"]>,
  timeout = 5_000,
): Promise<number> {
  const start = Date.now();
  await clickAction();
  await expect(successLocator).toBeVisible({ timeout });
  return Date.now() - start;
}

/**
 * Sample tab IDs at high frequency across a transition to detect blank/intermediate states.
 * Returns all unique snapshots observed.
 */
export async function sampleTabsDuringTransition(
  page: Page,
  action: () => Promise<void>,
  durationMs = 2_000,
  intervalMs = 30,
): Promise<string[][]> {
  const snapshots: string[][] = [];
  const startSampling = async () => {
    const start = Date.now();
    while (Date.now() - start < durationMs) {
      snapshots.push(await getTabTestIds(page));
      await page.waitForTimeout(intervalMs);
    }
  };

  const samplingPromise = startSampling();
  await action();
  await samplingPromise;
  return snapshots;
}

export function terminalSurfaceLocator(page: Page) {
  return page.locator('[data-testid="terminal-surface"]').first();
}

export async function expectAgentTabActive(page: Page, agentId: string): Promise<void> {
  const tabTestId = `workspace-tab-agent_${agentId}`;
  await expect(page.getByTestId(tabTestId).filter({ visible: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(getActiveTabTestId(page)).resolves.toBe(tabTestId);
}

// ─── Workspace setup ───────────────────────────────────────────────────────

/** Create a temp git repo and return its path with a cleanup function. */
export async function createWorkspace(
  prefix = "launcher-e2e-",
): ReturnType<typeof createTempGitRepo> {
  return createTempGitRepo(prefix);
}
