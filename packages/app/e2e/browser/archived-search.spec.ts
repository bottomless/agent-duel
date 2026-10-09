import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  archiveAgentFromDaemon,
  createIdleAgent,
  openArchived,
  resetSeededPageState,
} from "../support/helpers/archive-tab";

const ARCHIVED_CHAT_ROW = '[data-testid^="archived-chat-"]';

/**
 * Every seeded title opens with the same nonce, so a query of "<nonce> term"
 * can only reach this spec's chats. The daemon is shared with the rest of
 * the browser suite and its archive is whatever those specs left behind.
 */
const NONCE = `hsq${randomUUID().replaceAll("-", "").slice(0, 8)}`;

const TITLES = {
  billing: `${NONCE} Add Stripe billing`,
  unbilled: `${NONCE} Unbilled usage report`,
  terminal: `${NONCE} Terminal resize fix`,
} as const;

async function search(page: Page, query: string): Promise<void> {
  await page.getByTestId("sidebar-archived-search-input").fill(query);
}

function rowTitles(page: Page) {
  return page.locator(ARCHIVED_CHAT_ROW);
}

async function expectVisibleTitles(page: Page, titles: string[]): Promise<void> {
  const rows = rowTitles(page).filter({ hasText: NONCE });
  await expect(rows).toHaveCount(titles.length, { timeout: 30_000 });
  for (const [index, title] of titles.entries()) {
    await expect(rows.nth(index)).toContainText(title, { timeout: 30_000 });
  }
}

test.describe("Archived search", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  let projectId: string;

  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("archived-search-");
    client = await connectSeedClient();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${tempRepo.path}`);
    }
    projectId = created.workspace.projectId;
    const workspaceId = created.workspace.id;

    // Archived in creation order, so the newest chat is still the newest archived one.
    for (const title of [TITLES.terminal, TITLES.unbilled, TITLES.billing]) {
      const agent = await createIdleAgent(client, { cwd: tempRepo.path, workspaceId, title });
      await archiveAgentFromDaemon(client, agent.id);
    }
  });

  test.afterAll(async () => {
    await client?.removeProject(projectId).catch(() => undefined);
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup();
  });

  test("typing narrows archived chats to the matches and clearing restores them", async ({
    page,
  }) => {
    await resetSeededPageState(page);
    await openArchived(page);

    // Seeded newest-first, and at rest the archive is chronological.
    await expectVisibleTitles(page, [TITLES.billing, TITLES.unbilled, TITLES.terminal]);
    await expect(page.getByText("Today", { exact: true })).toHaveCount(1, { timeout: 30_000 });

    await search(page, `${NONCE} billing`);
    await expectVisibleTitles(page, [TITLES.billing]);

    // Ranked results are one flat list — a day heading would claim an order
    // the list no longer has.
    await expect(page.getByText("Today", { exact: true })).toHaveCount(0, { timeout: 30_000 });

    await page.getByTestId("sidebar-archived-search-clear").click();
    await expect(page.getByTestId("sidebar-archived-search-input")).toHaveValue("");
    await expectVisibleTitles(page, [TITLES.billing, TITLES.unbilled, TITLES.terminal]);
    await expect(page.getByText("Today", { exact: true })).toHaveCount(1, { timeout: 30_000 });
  });

  test("ranks a whole-word hit above one buried inside a word", async ({ page }) => {
    await resetSeededPageState(page);
    await openArchived(page);

    // "bill" starts a word in "billing" and hides inside "unbilled", so the
    // stronger match leads even though both chats are equally recent.
    await search(page, `${NONCE} bill`);
    await expectVisibleTitles(page, [TITLES.billing, TITLES.unbilled]);
  });

  test("marks the characters each result matched on", async ({ page }) => {
    await resetSeededPageState(page);
    await openArchived(page);

    // The mark is a nested Text run, so the matched slice is its own element.
    await search(page, `${NONCE} billing`);
    const row = page.locator(ARCHIVED_CHAT_ROW).filter({ hasText: NONCE }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText("billing", { exact: true })).toBeVisible({ timeout: 30_000 });

    // A typo has no characters in the text to point at, so the whole word it
    // resolved to is marked.
    await search(page, `${NONCE} bulling`);
    const typoRow = page.locator(ARCHIVED_CHAT_ROW).filter({ hasText: NONCE }).first();
    await expect(typoRow.getByText("billing", { exact: true })).toBeVisible({ timeout: 30_000 });
  });

  test("finds an archived chat through a typo", async ({ page }) => {
    await resetSeededPageState(page);
    await openArchived(page);

    await search(page, `${NONCE} bulling`);
    await expectVisibleTitles(page, [TITLES.billing]);
  });

  test("says the query found nothing, not that the archive is empty", async ({ page }) => {
    await resetSeededPageState(page);
    await openArchived(page);

    await search(page, `${NONCE} kubernetes`);
    await expect(page.getByTestId("sidebar-archived-empty")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("No archived chats match")).toBeVisible({ timeout: 30_000 });

    await page.getByText("Clear search").click();
    await expectVisibleTitles(page, [TITLES.billing, TITLES.unbilled, TITLES.terminal]);
  });
});
