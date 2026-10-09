import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { buildCreateAgentPreferences, buildSeededHost } from "./daemon-registry";
import { getE2EDaemonPort } from "./daemon-port";
import { getServerId } from "./server-id";
import { waitForWorkspaceTabsVisible } from "./workspace-tabs";
import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";

export interface ArchiveTabAgent {
  id: string;
  title: string;
  cwd: string;
  workspaceId: string;
}

function buildSeededStoragePayload() {
  const nowIso = new Date().toISOString();
  return {
    daemon: buildSeededHost({
      serverId: getServerId(),
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
      nowIso,
    }),
    preferences: buildCreateAgentPreferences(getServerId()),
  };
}

/**
 * The slice of a daemon client `createIdleAgent` needs: spawn an agent and await
 * its idle upsert. The shared seed client satisfies it, so a spec can seed an
 * idle agent from the same client it uses for everything else.
 */
export interface IdleAgentSeedClient {
  createAgent(options: {
    provider: string;
    model: string;
    modeId: string;
    featureValues?: Record<string, unknown>;
    cwd: string;
    workspaceId: string;
    title: string;
  }): Promise<{ id: string }>;
  waitForAgentUpsert(
    agentId: string,
    predicate: (snapshot: { status: string }) => boolean,
    timeout?: number,
  ): Promise<{ status: string }>;
}

export async function createIdleAgent(
  client: IdleAgentSeedClient,
  input: { cwd: string; workspaceId: string; title: string },
): Promise<ArchiveTabAgent> {
  const created = await client.createAgent({
    provider: "opencode",
    model: "opencode/gpt-5-nano",
    // OpenCode has no "bypassPermissions" mode (that's Claude's). Use build with
    // auto_accept for unattended full access — mode validation now rejects modes
    // the provider doesn't define.
    modeId: "build",
    featureValues: { auto_accept: true },
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    title: input.title,
  });
  const snapshot = await client.waitForAgentUpsert(
    created.id,
    (agent) => agent.status === "idle",
    30_000,
  );
  if (snapshot.status !== "idle") {
    throw new Error(`Expected agent ${created.id} to become idle, got ${snapshot.status}.`);
  }
  return {
    id: created.id,
    title: input.title,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
  };
}

export async function archiveAgentFromDaemon(
  client: { archiveAgent(agentId: string): Promise<{ archivedAt: string }> },
  agentId: string,
): Promise<void> {
  await client.archiveAgent(agentId);
}

export async function fetchAgentArchivedAt(
  client: {
    fetchAgent(options: {
      agentId: string;
    }): Promise<{ agent: { archivedAt?: string | null } } | null>;
  },
  agentId: string,
): Promise<string | null> {
  const result = await client.fetchAgent({ agentId });
  return result?.agent.archivedAt ?? null;
}

export async function primeAdditionalPage(page: Page): Promise<void> {
  const seedNonce = randomUUID();
  const { daemon, preferences } = buildSeededStoragePayload();

  await page.route(/:(6767)\b/, (route) => route.abort());
  await page.routeWebSocket(/:(6767)\b/, async (ws) => {
    await ws.close({ code: 1008, reason: "Blocked connection to localhost:6767 during e2e." });
  });
  await page.addInitScript(
    ({ daemon: seededDaemon, preferences: seededPreferences, seedNonce: nonce }) => {
      const disableOnceKey = "@paseo:e2e-disable-default-seed-once";
      const disableValue = localStorage.getItem(disableOnceKey);
      if (disableValue) {
        localStorage.removeItem(disableOnceKey);
        if (disableValue === nonce) {
          return;
        }
      }

      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:e2e-seed-nonce", nonce);
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededDaemon]));
      localStorage.removeItem("@paseo:settings");
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(seededPreferences));
    },
    { daemon, preferences, seedNonce },
  );
  await page.goto("/");
}

export async function resetSeededPageState(page: Page): Promise<void> {
  const { daemon, preferences } = buildSeededStoragePayload();
  await page.goto("/");
  await page.evaluate(
    ({ daemon: seededDaemon, preferences: seededPreferences }) => {
      localStorage.clear();
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededDaemon]));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(seededPreferences));
      localStorage.removeItem("@paseo:settings");
    },
    { daemon, preferences },
  );
  await page.goto("/");
}

export async function openWorkspaceWithAgents(
  page: Page,
  agents: [ArchiveTabAgent, ArchiveTabAgent],
): Promise<void> {
  const serverId = getServerId();
  for (const agent of agents) {
    await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.workspaceId));

    // The workspace layout consumes `?open=agent:xxx`, returns null during the effect,
    // then replaces the URL with the clean workspace route after preparing the tab.
    // On CI, Expo Router's rootNavigationState may take time to initialize,
    // so we allow a generous timeout here (matching terminal-perf pattern).
    await page.waitForURL(
      (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
      { timeout: 60_000 },
    );

    await waitForWorkspaceTabsVisible(page);
    await expectWorkspaceTabVisible(page, agent.id);
  }
}

export async function expectWorkspaceTabVisible(page: Page, agentId: string): Promise<void> {
  await expect(
    page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

export async function expectWorkspaceTabHidden(page: Page, agentId: string): Promise<void> {
  await expect(
    page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }),
  ).toHaveCount(0, {
    timeout: 30_000,
  });
}

export async function expectWorkspaceArchiveOutcome(
  page: Page,
  input: { archivedAgentId: string; survivingAgentId: string },
): Promise<void> {
  await expectWorkspaceTabHidden(page, input.archivedAgentId);
  await expectWorkspaceTabVisible(page, input.survivingAgentId);
}

export async function closeWorkspaceAgentTab(page: Page, agentId: string): Promise<void> {
  const closeButton = page.getByTestId(`workspace-agent-close-${agentId}`).filter({
    visible: true,
  });
  await expect(closeButton.first()).toBeVisible({ timeout: 30_000 });
  await closeButton.first().click();
  await expectWorkspaceTabHidden(page, agentId);
}

export async function expectArchivedAgentFocused(page: Page, agentId: string): Promise<void> {
  await expectWorkspaceTabVisible(page, agentId);
  await expect(
    page.getByText("This agent is archived").filter({ visible: true }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
}

export async function reloadWorkspace(page: Page, workspaceId: string): Promise<void> {
  const serverId = getServerId();
  await page.goto(buildHostWorkspaceRoute(serverId, workspaceId));
  await waitForWorkspaceTabsVisible(page);
}

/**
 * Swaps the sidebar's list for the archived chats. The route stays where it was, and
 * the view stays open across navigation, so a second call finds it already open.
 */
export async function openArchived(page: Page): Promise<void> {
  const archivedView = page.getByTestId("sidebar-archived").filter({ visible: true }).first();
  const archivedButton = page
    .getByTestId("sidebar-archived-open")
    .filter({ visible: true })
    .first();
  await expect(archivedView.or(archivedButton)).toBeVisible({ timeout: 30_000 });
  if (!(await archivedView.isVisible())) {
    await archivedButton.click();
  }
  await expect(archivedView).toBeVisible({ timeout: 30_000 });
}

const ARCHIVED_CHAT_SELECTOR = '[data-testid^="archived-chat-"]';

function getArchivedChatByTitle(page: Page, title: string) {
  return page.locator(ARCHIVED_CHAT_SELECTOR).filter({ hasText: title }).first();
}

export async function expectArchivedChatVisible(page: Page, title: string): Promise<void> {
  await expect(getArchivedChatByTitle(page, title)).toBeVisible({ timeout: 30_000 });
}

export async function expectArchivedChatAbsent(page: Page, title: string): Promise<void> {
  await expect(page.locator(ARCHIVED_CHAT_SELECTOR).filter({ hasText: title })).toHaveCount(0, {
    timeout: 30_000,
  });
}

export async function clickArchivedChat(page: Page, title: string): Promise<void> {
  const row = getArchivedChatByTitle(page, title);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
}

export async function expectArchivedEmptyState(page: Page): Promise<void> {
  // Guard: the archived-empty spec owns a pristine daemon, so this helper only
  // needs to distinguish an empty result from the expected seeded rows.
  await expect(page.locator(ARCHIVED_CHAT_SELECTOR)).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByText("No archived chats", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}
