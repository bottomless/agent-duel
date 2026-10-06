import { existsSync } from "node:fs";
import path from "node:path";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  addProjectViaDaemon,
  archiveWorkspaceFromDaemon,
  archiveLocalWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  closeBranchPicker,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  delayBrowserAgentCreatedStatus,
  expectComposerGithubAttachmentPill,
  expectNewWorkspaceProjectSelected,
  expectPickerClosed,
  expectPickerOpen,
  expectPickerSelected,
  expectNewBranchNameRejected,
  expectStartingRefPickerTriggerPr,
  fillNewWorkspaceDraft,
  openGlobalNewWorkspaceComposer,
  openBranchPicker,
  openNewBranchDialog,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  openStartingRefPicker,
  pasteGithubPrUrl,
  captureStartingRefPicker,
  expectStartingRefRows,
  startingRefRow,
  submitNewWorkspaceEmpty,
  searchAndSelectBranchInPicker,
  selectBranchInPicker,
  selectNewWorkspaceIsolation,
  submitNewBranchName,
  selectGitHubPrInPicker,
  selectPickerOptionByKeyboard,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import {
  commitLocalOnly,
  createTempGitRepo,
  deleteRepoBranchOutsideApp,
  readRepoRef,
  readWorktreeBaseMetadata,
  readWorktreeBranchInfo,
  switchRepoBranchOutsideApp,
  trackForkUpstream,
} from "../support/helpers/workspace";
import {
  createLocalGithubPrFixture,
  cloneGithubRepoDefaultBranchOnly,
  createTempGithubRepo,
  hasGithubAuth,
  type LocalGhPrFixture,
} from "../support/helpers/github-fixtures";
import { getCurrentWorkspaceIdFromRoute } from "../support/helpers/workspace-setup";
import { getServerId } from "../support/helpers/server-id";
import { selectSidebarStatusGrouping } from "../support/helpers/sidebar";
import { chooseAddProjectMethod, expectAddProjectPage } from "../support/helpers/add-project-flow";
import {
  expectSidebarWorkspaceSelected,
  expectWorkspaceHeader,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";
import { dropFileOnComposer, expectAttachmentPill } from "../support/helpers/composer";

const BACKGROUND_RESOLUTION_FILE = {
  name: "background-context.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({ composer: "background-resolution" })),
};

interface WorkspaceStatusGroupEvent {
  rowTestId: string;
  bucket: string;
  indicatorTestId: string | null;
  label: string;
  at: number;
}

async function switchSidebarToStatusGrouping(page: import("@playwright/test").Page) {
  await selectSidebarStatusGrouping(page);
  await expect(page.getByTestId("sidebar-status-group-done")).toBeVisible({ timeout: 30_000 });
}

async function startTrackingSidebarStatusGroups(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    interface StatusGroupEvent {
      rowTestId: string;
      bucket: string;
      indicatorTestId: string | null;
      label: string;
      at: number;
    }
    const win = window as typeof window & {
      __workspaceStatusGroupEvents?: StatusGroupEvent[];
      __workspaceStatusGroupObserver?: MutationObserver;
    };
    win.__workspaceStatusGroupEvents = [];
    win.__workspaceStatusGroupObserver?.disconnect();

    const capture = () => {
      const events = win.__workspaceStatusGroupEvents;
      if (!events) return;
      const groups = document.querySelectorAll<HTMLElement>(
        '[data-testid^="sidebar-status-group-"]',
      );
      for (const group of groups) {
        const groupTestId = group.getAttribute("data-testid") ?? "";
        const bucket = groupTestId.replace("sidebar-status-group-", "");
        const label = group.textContent ?? "";
        const block = group.parentElement?.parentElement;
        if (!block) continue;
        const rows = block.querySelectorAll<HTMLElement>('[data-testid^="sidebar-workspace-row-"]');
        for (const row of rows) {
          const rowTestId = row.getAttribute("data-testid");
          if (!rowTestId) continue;
          const indicatorTestId =
            row
              .querySelector<HTMLElement>('[data-testid^="workspace-status-indicator-"]')
              ?.getAttribute("data-testid") ?? null;
          const last = events.at(-1);
          if (
            last?.rowTestId === rowTestId &&
            last.bucket === bucket &&
            last.indicatorTestId === indicatorTestId
          ) {
            continue;
          }
          events.push({ rowTestId, bucket, indicatorTestId, label, at: performance.now() });
        }
      }
    };

    capture();
    const observer = new MutationObserver(capture);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-testid"],
    });
    win.__workspaceStatusGroupObserver = observer;
  });
}

async function getTrackedSidebarStatusGroups(
  page: import("@playwright/test").Page,
): Promise<WorkspaceStatusGroupEvent[]> {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __workspaceStatusGroupEvents?: WorkspaceStatusGroupEvent[];
    };
    return win.__workspaceStatusGroupEvents ?? [];
  });
}

async function waitForWorkspaceStatusGroupEvent(input: {
  page: import("@playwright/test").Page;
  rowTestId: string;
  bucket: string;
}) {
  await input.page.waitForFunction(
    ({ expectedRowTestId, expectedBucket }) => {
      const win = window as typeof window & {
        __workspaceStatusGroupEvents?: WorkspaceStatusGroupEvent[];
      };
      for (const event of win.__workspaceStatusGroupEvents ?? []) {
        if (event.rowTestId === expectedRowTestId && event.bucket === expectedBucket) {
          return true;
        }
      }
      return false;
    },
    { expectedRowTestId: input.rowTestId, expectedBucket: input.bucket },
    { timeout: 30_000 },
  );
}

async function expectWorkspaceStatusGroupEvents(input: {
  page: import("@playwright/test").Page;
  rowTestId: string;
  includes: string;
  excludes: string;
  excludesIndicator?: string;
}) {
  await waitForWorkspaceStatusGroupEvent({
    page: input.page,
    rowTestId: input.rowTestId,
    bucket: input.includes,
  });
  const createdWorkspaceEvents = (await getTrackedSidebarStatusGroups(input.page)).filter(
    (event) => event.rowTestId === input.rowTestId,
  );
  expect(createdWorkspaceEvents.map((event) => event.bucket)).toContain(input.includes);
  expect(createdWorkspaceEvents.filter((event) => event.bucket === input.excludes)).toEqual([]);
  if (input.excludesIndicator) {
    expect(
      createdWorkspaceEvents.filter((event) => event.indicatorTestId === input.excludesIndicator),
    ).toEqual([]);
  }
}

async function submitNewWorkspaceWithoutPrompt(page: import("@playwright/test").Page) {
  const createButton = page
    .getByTestId("message-input-root")
    .getByRole("button", { name: "Create" });
  await expect(createButton).toBeVisible({ timeout: 30_000 });
  await createButton.click();
}

test.describe("New workspace flow", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();
  const localProjectIds = new Set<string>();
  const createdWorktreeDirectories = new Set<string>();
  const localGithubFixtures = new Set<LocalGhPrFixture>();

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    if (client) {
      for (const workspaceDirectory of createdWorktreeDirectories) {
        await archiveWorkspaceFromDaemon(client, workspaceDirectory).catch(() => undefined);
      }
      for (const workspaceId of localWorkspaceIds) {
        await archiveLocalWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
      for (const projectId of localProjectIds) {
        await client.removeProject(projectId).catch(() => undefined);
      }
    }
    createdWorktreeDirectories.clear();
    localWorkspaceIds.clear();
    localProjectIds.clear();
    await client?.close().catch(() => undefined);
  });

  test.afterAll(async () => {
    for (const fixture of localGithubFixtures) {
      await fixture.cleanup();
    }
    localGithubFixtures.clear();
  });

  test("adds a project when the search has no matching project", async ({ page }) => {
    const repo = await createTempGitRepo("new-workspace-project-picker-");

    try {
      const openedProject = await openProjectViaDaemon(client, repo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);

      const projectTrigger = page.getByTestId("new-workspace-project-picker-trigger");
      await projectTrigger.click();
      await page.getByPlaceholder("Search projects").fill("no matching project");
      await expect(page.getByTestId("new-workspace-project-picker-add-project")).toBeVisible();
      await page.keyboard.press("Escape");

      await projectTrigger.click();

      const addProject = page.getByTestId("new-workspace-project-picker-add-project");
      await expect(addProject).toContainText("Add project");
      await expect(addProject).toContainText(/(?:⌘|Ctrl\+)O/);
      await addProject.click();

      await expectAddProjectPage(page, "method");
      await chooseAddProjectMethod(page, "directory-search");
    } finally {
      await repo.cleanup();
    }
  });

  test("sidebar workspace navigation updates URL and header", async ({ page }) => {
    const serverId = getServerId();

    const firstRepo = await createTempGitRepo("workspace-nav-a-");
    const secondRepo = await createTempGitRepo("workspace-nav-b-");

    try {
      const firstWorkspace = await openProjectViaDaemon(client, firstRepo.path);
      const secondWorkspace = await openProjectViaDaemon(client, secondRepo.path);
      localWorkspaceIds.add(firstWorkspace.workspaceId);
      localWorkspaceIds.add(secondWorkspace.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await waitForWorkspaceInSidebar(page, {
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: secondWorkspace.workspaceName,
        subtitle: secondWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });
    } finally {
      await secondRepo.cleanup();
      await firstRepo.cleanup();
    }
  });

  test("same-project workspaces switch content without requiring refresh", async ({ page }) => {
    const serverId = getServerId();

    const repo = await createTempGitRepo("workspace-nav-same-project-");

    try {
      const rootWorkspace = await openProjectViaDaemon(client, repo.path);
      const worktreeWorkspace = await createWorktreeViaDaemon(client, {
        cwd: repo.path,
        slug: `nav-${Date.now()}`,
      });
      localWorkspaceIds.add(rootWorkspace.workspaceId);
      createdWorktreeDirectories.add(worktreeWorkspace.workspaceDirectory);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: rootWorkspace.workspaceName,
        subtitle: rootWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: worktreeWorkspace.workspaceName,
        subtitle: worktreeWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
        selected: false,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: rootWorkspace.workspaceName,
        subtitle: rootWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
        selected: false,
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("global new workspace uses the last active project and creates one agent tab", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspacePrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      expect(createdWorkspace.workspaceId).not.toBe(openedProject.workspaceId);
      await expect(page).toHaveURL(
        buildHostWorkspaceRoute(serverId, createdWorkspace.workspaceId),
        {
          timeout: 30_000,
        },
      );

      const createdWorkspaceRow = page.getByTestId(
        `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`,
      );
      await expect(createdWorkspaceRow).toBeVisible({ timeout: 30_000 });

      await expectWorkspaceHeader(page, {
        title: createdWorkspace.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      const activeWorkspaceDeckEntry = page
        .getByTestId(`workspace-deck-entry-${serverId}:${createdWorkspace.workspaceId}`)
        .filter({ visible: true });
      await expect(activeWorkspaceDeckEntry).toBeVisible({ timeout: 30_000 });

      const agentTabs = activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]');
      await expect(agentTabs).toHaveCount(1, { timeout: 30_000 });

      // Workspace setup may auto-open a setup tab that steals focus,
      // hiding the agent panel (display:none removes it from the
      // accessibility tree). Click the agent tab to ensure it's active.
      await agentTabs.first().click();

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeVisible({ timeout: 30_000 });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("redirects to the optimistic draft tab before agent creation resolves", async ({ page }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-optimistic-");
    const agentCreatedDelay = await delayBrowserAgentCreatedStatus(page);

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await composer.fill("Hello from e2e");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      await agentCreatedDelay.waitForCreateRequest();
      await agentCreatedDelay.waitForDelayedCreatedStatus();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      await expect(page).toHaveURL(
        buildHostWorkspaceRoute(serverId, createdWorkspace.workspaceId),
        {
          timeout: 30_000,
        },
      );

      const activeWorkspaceDeckEntry = page
        .getByTestId(`workspace-deck-entry-${serverId}:${createdWorkspace.workspaceId}`)
        .filter({ visible: true });
      await expect(activeWorkspaceDeckEntry).toBeVisible({ timeout: 30_000 });

      const draftTabs = activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-draft_"]');
      await expect(draftTabs).toHaveCount(1, { timeout: 30_000 });
      await expect(
        activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]'),
      ).toHaveCount(0);

      agentCreatedDelay.release();
      await expect(
        activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]'),
      ).toHaveCount(1, { timeout: 30_000 });
    } finally {
      agentCreatedDelay.release();
      await tempRepo.cleanup();
    }
  });

  test("new workspace with initial agent never appears in the Done status group", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-status-optimistic-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await switchSidebarToStatusGrouping(page);
      await startTrackingSidebarStatusGroups(page);

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspacePrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      const rowTestId = `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`;
      await expectWorkspaceStatusGroupEvents({
        page,
        rowTestId,
        includes: "running",
        excludes: "done",
      });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("new workspace without an initial agent appears in the Done status group", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-status-empty-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await switchSidebarToStatusGrouping(page);
      await startTrackingSidebarStatusGroups(page);

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspaceWithoutPrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      const rowTestId = `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`;
      await expectWorkspaceStatusGroupEvents({
        page,
        rowTestId,
        includes: "done",
        excludes: "running",
        excludesIndicator: "workspace-status-indicator-loading",
      });
      await expectWorkspaceStatusGroupEvents({
        page,
        rowTestId,
        includes: "done",
        excludes: "running",
        excludesIndicator: "workspace-status-indicator-running",
      });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("selected branch becomes the base of a new workspace worktree", async ({ page }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-ref-", {
      branches: ["main", "dev"],
    });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectNewWorkspaceIsolation(page, "worktree");
      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "dev");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      expect(existsSync(createdWorkspace.workspaceDirectory)).toBe(true);

      const branchInfo = await readWorktreeBranchInfo({
        worktreePath: createdWorkspace.workspaceDirectory,
      });
      expect(branchInfo.currentBranch).toBe("");
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.main)).toBe(true);
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.dev)).toBe(true);
    } finally {
      await tempRepo.cleanup();
    }
  });

  // Picking a branch in Local mode is a checkout, not a form value. The pair matters as much as
  // either half: Worktree mode must leave the source checkout exactly where it was.
  test("picking a branch checks it out in Local mode and leaves the checkout alone in Worktree mode", async ({
    page,
  }) => {
    const tempRepo = await createTempGitRepo("pick-branch-checkout-", {
      branches: ["main", "dev"],
    });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });

      await selectNewWorkspaceIsolation(page, "local");
      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "dev");
      await expect
        .poll(
          async () => (await readWorktreeBranchInfo({ worktreePath: tempRepo.path })).currentBranch,
          {
            timeout: 30_000,
          },
        )
        .toBe("dev");

      await selectNewWorkspaceIsolation(page, "worktree");
      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "main");
      // Nothing to wait for: the assertion is that no checkout happens at all.
      await page.waitForTimeout(1_000);
      expect((await readWorktreeBranchInfo({ worktreePath: tempRepo.path })).currentBranch).toBe(
        "dev",
      );
    } finally {
      await tempRepo.cleanup();
    }
  });

  // Local mode is the checkout the developer is looking at, so confirming the dialog has to move
  // it there and then — the same thing Codex's create-and-checkout does. Nothing is submitted
  // here on purpose: the assertion is that git already changed.
  test("naming a branch in Local mode checks it out before anything is submitted", async ({
    page,
  }) => {
    const tempRepo = await createTempGitRepo("new-branch-local-now-", {
      branches: ["main", "dev"],
    });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectNewWorkspaceIsolation(page, "local");

      expect((await readWorktreeBranchInfo({ worktreePath: tempRepo.path })).currentBranch).toBe(
        "main",
      );

      await openStartingRefPicker(page);
      await openNewBranchDialog(page, "main");
      await submitNewBranchName(page, "feature/checked-out-now");

      const branchInfo = await readWorktreeBranchInfo({ worktreePath: tempRepo.path });
      expect(branchInfo.currentBranch).toBe("feature/checked-out-now");
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.main)).toBe(true);
    } finally {
      await tempRepo.cleanup();
    }
  });

  // The first chat in a project is its own case: until a workspace exists the daemon registers no
  // git observer for the cwd, so no checkout-status push ever corrects the app's cached branch.
  // Submitting used to redo the create the dialog had already done and die on "branch already
  // exists", which every other test here misses because opening a project also opens a chat.
  test("submits the first chat in a project after naming a branch", async ({ page }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("first-chat-new-branch-", {
      branches: ["main", "dev"],
    });

    try {
      const project = await addProjectViaDaemon(client, tempRepo.path);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: project.projectKey,
        projectDisplayName: project.projectDisplayName,
      });
      await selectNewWorkspaceIsolation(page, "local");

      await openStartingRefPicker(page);
      await openNewBranchDialog(page, "main");
      await submitNewBranchName(page, "feature/first-chat");

      await submitNewWorkspaceEmpty(page);

      const workspaceId = await getCurrentWorkspaceIdFromRoute(page);
      localWorkspaceIds.add(workspaceId);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, workspaceId), {
        timeout: 30_000,
      });

      const branchInfo = await readWorktreeBranchInfo({ worktreePath: tempRepo.path });
      expect(branchInfo.currentBranch).toBe("feature/first-chat");
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.main)).toBe(true);
    } finally {
      await tempRepo.cleanup();
    }
  });

  // The base the dialog names is a promise about which commit the branch starts at, and the
  // checkout can move out from under it. An explicit selection must survive a status refresh
  // when the picker reopens, even for a project with no checkout-status pushes. These
  // three cover what that promise is worth in each isolation mode, and when it cannot be kept.
  //
  // "dev" is created before "main" so the two diverge from the initial commit. Branches that
  // stack would make the wrong base an ancestor of the right one and prove nothing.
  const STALE_BASE_BRANCHES = ["dev", "main"];

  test("cuts a named branch from the base the picker showed, not the branch the checkout moved to", async ({
    page,
  }) => {
    const tempRepo = await createTempGitRepo("new-branch-stale-base-local-", {
      branches: STALE_BASE_BRANCHES,
    });

    try {
      const project = await addProjectViaDaemon(client, tempRepo.path);
      localProjectIds.add(project.projectId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: project.projectKey,
        projectDisplayName: project.projectDisplayName,
      });
      await selectNewWorkspaceIsolation(page, "local");

      // Keep the explicit base selection while Git moves outside the app.
      await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText("main");
      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "main");
      await expectPickerClosed(page);
      switchRepoBranchOutsideApp(tempRepo.path, "dev");

      await openStartingRefPicker(page);
      await openNewBranchDialog(page, "main");
      await submitNewBranchName(page, "feature/from-shown-base");

      await expect
        .poll(
          async () => (await readWorktreeBranchInfo({ worktreePath: tempRepo.path })).currentBranch,
        )
        .toBe("feature/from-shown-base");
      const branchInfo = await readWorktreeBranchInfo({ worktreePath: tempRepo.path });
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.main)).toBe(true);
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.dev)).toBe(false);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("cuts a named worktree branch from the base the picker showed after the checkout moved", async ({
    page,
  }) => {
    const serverId = getServerId();
    const tempRepo = await createTempGitRepo("new-branch-stale-base-worktree-", {
      branches: STALE_BASE_BRANCHES,
    });

    try {
      const project = await addProjectViaDaemon(client, tempRepo.path);
      localProjectIds.add(project.projectId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: project.projectKey,
        projectDisplayName: project.projectDisplayName,
      });
      await selectNewWorkspaceIsolation(page, "worktree");

      await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText("main");
      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "main");
      await expectPickerClosed(page);
      switchRepoBranchOutsideApp(tempRepo.path, "dev");

      await openStartingRefPicker(page);
      await openNewBranchDialog(page, "main");
      await submitNewBranchName(page, "feature/worktree-from-shown-base");

      await submitNewWorkspaceEmpty(page);
      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        // The project has no chats, so any workspace id on the route is the created one.
        previousWorkspaceId: "",
        projectDisplayName: project.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      const branchInfo = await readWorktreeBranchInfo({
        worktreePath: createdWorkspace.workspaceDirectory,
      });
      expect(branchInfo.currentBranch).toBe("feature/worktree-from-shown-base");
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.main)).toBe(true);
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.dev)).toBe(false);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("refuses to name a branch when the base the picker showed is gone", async ({ page }) => {
    const tempRepo = await createTempGitRepo("new-branch-deleted-base-", {
      branches: STALE_BASE_BRANCHES,
    });

    try {
      const project = await addProjectViaDaemon(client, tempRepo.path);
      localProjectIds.add(project.projectId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: project.projectKey,
        projectDisplayName: project.projectDisplayName,
      });
      await selectNewWorkspaceIsolation(page, "local");

      await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText("main");
      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "main");
      await expectPickerClosed(page);
      await openStartingRefPicker(page);
      await openNewBranchDialog(page, "main");
      // Delete after opening the dialog: reopening the menu now validates and
      // clears a deleted selection before a new branch can be named from it.
      switchRepoBranchOutsideApp(tempRepo.path, "dev");
      deleteRepoBranchOutsideApp(tempRepo.path, "main");

      await expectNewBranchNameRejected(page, {
        name: "feature/no-base",
        error: "Branch main no longer exists.",
      });

      // Refusing means refusing: nothing was cut, and the checkout stays where it was.
      const branchInfo = await readWorktreeBranchInfo({ worktreePath: tempRepo.path });
      expect(branchInfo.currentBranch).toBe("dev");
    } finally {
      await tempRepo.cleanup();
    }
  });

  // A branch named in the picker is only a name until the workspace is created, so the proof
  // is the created worktree's branch and its commits — never the trigger text.
  test("a branch named in the picker is cut from the picked ref", async ({ page }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-new-branch-", {
      branches: ["main", "dev"],
    });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });

      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "dev");
      await openStartingRefPicker(page);
      await openNewBranchDialog(page, "dev");

      await expectNewBranchNameRejected(page, {
        name: "feature/",
        error: "Branch name cannot end with",
      });
      // The checkout, not the suggestion list, decides whether a name is free.
      await expectNewBranchNameRejected(page, { name: "dev", error: "Branch already exists." });

      await submitNewBranchName(page, "feature/from-dev");
      await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText(
        "feature/from-dev",
      );

      await submitNewWorkspaceEmpty(page);
      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      const branchInfo = await readWorktreeBranchInfo({
        worktreePath: createdWorkspace.workspaceDirectory,
      });
      expect(branchInfo.currentBranch).toBe("feature/from-dev");
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.dev)).toBe(true);
    } finally {
      await tempRepo.cleanup();
    }
  });

  // The starting ref the daemon actually cuts from is the thing that broke: the picker said
  // one ref and the worktree was created from another. Every assertion here reads the
  // created worktree's commits or its recorded base, never the trigger text alone.
  test.describe("default starting ref", () => {
    async function openWorktreeComposerForRepo(
      page: import("@playwright/test").Page,
      repoPath: string,
    ) {
      const openedProject = await openProjectViaDaemon(client, repoPath);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      // Isolation defaults to Local, where the checkout is switched by branch name rather than
      // branched off a ref. Every assertion in this block reads a worktree's commits, so the
      // mode has to be chosen rather than inherited.
      await selectNewWorkspaceIsolation(page, "worktree");
      return openedProject;
    }

    async function createWorktreeAndRead(
      page: import("@playwright/test").Page,
      openedProject: Awaited<ReturnType<typeof openProjectViaDaemon>>,
    ) {
      await submitNewWorkspaceEmpty(page);
      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId: getServerId(),
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);
      return {
        ...createdWorkspace,
        branchInfo: await readWorktreeBranchInfo({
          worktreePath: createdWorkspace.workspaceDirectory,
        }),
      };
    }

    test("branches off the upstream when the local branch is ahead and the picker is untouched", async ({
      page,
    }) => {
      const tempRepo = await createTempGitRepo("ref-default-ahead-", { withRemote: true });

      try {
        const originHead = readRepoRef(tempRepo.path, "refs/remotes/origin/main");
        commitLocalOnly(tempRepo.path, "one");
        const localHead = commitLocalOnly(tempRepo.path, "two");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);
        const created = await createWorktreeAndRead(page, openedProject);

        expect(created.branchInfo.hasAncestor(originHead)).toBe(true);
        expect(created.branchInfo.hasAncestor(localHead)).toBe(false);
      } finally {
        await tempRepo.cleanup();
      }
    });

    // Detaching a worktree defaults to the upstream so unpushed commits stay out of a workspace
    // nobody asked to carry them into. Naming a branch is the opposite intent, so the same
    // untouched picker has to resolve to the local ref and bring those commits along.
    test("cuts a named branch from the local ref even though the picker defaults to the upstream", async ({
      page,
    }) => {
      const tempRepo = await createTempGitRepo("ref-new-branch-local-", { withRemote: true });

      try {
        const originHead = readRepoRef(tempRepo.path, "refs/remotes/origin/main");
        commitLocalOnly(tempRepo.path, "one");
        const localHead = commitLocalOnly(tempRepo.path, "two");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);

        await openStartingRefPicker(page);
        await openNewBranchDialog(page, "main");
        await submitNewBranchName(page, "feature/from-local");

        const created = await createWorktreeAndRead(page, openedProject);
        expect(created.branchInfo.currentBranch).toBe("feature/from-local");
        expect(created.branchInfo.hasAncestor(originHead)).toBe(true);
        expect(created.branchInfo.hasAncestor(localHead)).toBe(true);
      } finally {
        await tempRepo.cleanup();
      }
    });

    test("branches off the local ref when the local row is chosen explicitly", async ({
      page,
    }, testInfo) => {
      const tempRepo = await createTempGitRepo("ref-default-local-pick-", { withRemote: true });

      try {
        commitLocalOnly(tempRepo.path, "one");
        const localHead = commitLocalOnly(tempRepo.path, "two");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);

        await openStartingRefPicker(page);
        await expectStartingRefRows(page, [
          "main, origin branch",
          "main, local branch, 2 commits ahead of origin main",
        ]);
        const screenshotPath = testInfo.outputPath("ref-picker-local-ahead.png");
        await captureStartingRefPicker(page, screenshotPath);
        await testInfo.attach("Ref picker: local ahead of upstream", {
          path: screenshotPath,
          contentType: "image/png",
        });
        await startingRefRow(page, "main, local branch, 2 commits ahead of origin main").click();
        await expectPickerSelected(page, "main (local)");

        const created = await createWorktreeAndRead(page, openedProject);
        expect(created.branchInfo.hasAncestor(localHead)).toBe(true);
      } finally {
        await tempRepo.cleanup();
      }
    });

    test("branches off a fork's upstream remote and records the branch name", async ({
      page,
    }, testInfo) => {
      const tempRepo = await createTempGitRepo("ref-default-fork-", { withRemote: true });

      try {
        const upstreamHead = await trackForkUpstream(tempRepo.path);
        const originHead = readRepoRef(tempRepo.path, "refs/remotes/origin/main");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);

        await openStartingRefPicker(page);
        // Branch suggestions only know about origin, so the upstream the fork actually
        // tracks gets its own row rather than silently sharing origin's. Two rows reading
        // "main" is the ambiguity this whole change exists to remove.
        await expectStartingRefRows(page, [
          "main (upstream), upstream branch",
          "main, origin branch",
        ]);
        await expectPickerSelected(page, "main (upstream)");
        const screenshotPath = testInfo.outputPath("ref-picker-fork.png");
        await captureStartingRefPicker(page, screenshotPath);
        await testInfo.attach("Ref picker: fork tracking upstream/main", {
          path: screenshotPath,
          contentType: "image/png",
        });
        await closeBranchPicker(page);

        const created = await createWorktreeAndRead(page, openedProject);

        expect(created.branchInfo.hasAncestor(upstreamHead)).toBe(true);
        expect(upstreamHead).not.toBe(originHead);
        // The name is what the UI shows; the ref is what resolves back to this commit.
        expect(await readWorktreeBaseMetadata(created.workspaceDirectory)).toEqual({
          baseRefName: "main",
          baseRef: "refs/remotes/upstream/main",
        });
      } finally {
        await tempRepo.cleanup();
      }
    });
  });

  test("branch picker opens via keyboard and selects the filtered option on Enter", async ({
    page,
  }) => {
    const tempRepo = await createTempGitRepo("picker-keyboard-", { branches: ["main", "dev"] });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await openBranchPicker(page);
      await expectPickerOpen(page);
      await selectPickerOptionByKeyboard(page, "dev");
      await expectPickerSelected(page, "dev");
      await expectPickerClosed(page);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("branch picker closes on Escape without selecting an option", async ({ page }) => {
    const tempRepo = await createTempGitRepo("picker-escape-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await openBranchPicker(page);
      await expectPickerOpen(page);
      await closeBranchPicker(page);
      await expectPickerClosed(page);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("selected GitHub PR shows PR context in the trigger and composer", async ({ page }) => {
    test.skip(!hasGithubAuth(), "Requires GitHub authentication (gh auth login)");

    const ghRepo = await createTempGithubRepo({
      category: "new-workspace-pr-ref",
      prs: [{ title: "Review selected start ref", state: "open" }],
    });
    const pr = ghRepo.prs[0]!;

    try {
      const openedProject = await openProjectViaDaemon(client, pr.localPath);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await openStartingRefPicker(page);
      await selectGitHubPrInPicker(page, pr.number);

      await expectStartingRefPickerTriggerPr(page, {
        number: pr.number,
        title: pr.title,
        headRef: pr.branch,
      });
      await expectComposerGithubAttachmentPill(page, {
        number: pr.number,
        title: pr.title,
      });
    } finally {
      await ghRepo.cleanup();
    }
  });

  test("pasted GitHub PR replaces a selected branch and creates its worktree", async ({
    page,
    context,
  }) => {
    const fixture = await createLocalGithubPrFixture();
    localGithubFixtures.add(fixture);
    const { pr, mainCheckout } = fixture;

    const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
    localWorkspaceIds.add(openedProject.workspaceId);
    localProjectIds.add(openedProject.projectId);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: openedProject.projectKey,
      projectDisplayName: openedProject.projectDisplayName,
    });
    await openStartingRefPicker(page);
    await selectBranchInPicker(page, "main");

    await pasteGithubPrUrl(page, context, pr.url);

    const createButton = page.getByTestId("workspace-create-submit");
    await expect(createButton).toBeDisabled();
    await expect(createButton.getByRole("progressbar")).toHaveCount(0);

    await dropFileOnComposer(page, BACKGROUND_RESOLUTION_FILE);
    await expectAttachmentPill(page, "composer-file-attachment-pill");

    await expectComposerGithubAttachmentPill(page, {
      number: pr.number,
      title: pr.title,
    });
    await expectStartingRefPickerTriggerPr(page, {
      number: pr.number,
      title: pr.title,
      headRef: pr.branch,
    });

    await submitNewWorkspaceWithoutPrompt(page);

    const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: openedProject.workspaceId,
      projectDisplayName: openedProject.projectDisplayName,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    const branchInfo = await readWorktreeBranchInfo({
      worktreePath: worktree.workspaceDirectory,
    });
    expect(branchInfo.currentBranch).toBe(pr.branch);
    expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(true);
  });

  test("branches remain searchable after a pasted PR and determine the created worktree", async ({
    page,
    context,
  }) => {
    const fixture = await createLocalGithubPrFixture();
    localGithubFixtures.add(fixture);
    const { pr, mainCheckout } = fixture;

    const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
    localWorkspaceIds.add(openedProject.workspaceId);
    localProjectIds.add(openedProject.projectId);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: openedProject.projectKey,
      projectDisplayName: openedProject.projectDisplayName,
    });
    await pasteGithubPrUrl(page, context, pr.url);
    await expectStartingRefPickerTriggerPr(page, {
      number: pr.number,
      title: pr.title,
      headRef: pr.branch,
    });

    await openStartingRefPicker(page);
    await searchAndSelectBranchInPicker(page, "main");
    await expectPickerSelected(page, "main");
    await fillNewWorkspaceDraft(page, `${pr.url}\nKeep this checkout on main`);
    await expectPickerSelected(page, "main");
    await submitNewWorkspaceWithoutPrompt(page);

    const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: openedProject.workspaceId,
      projectDisplayName: openedProject.projectDisplayName,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(false);
  });

  test("selected GitHub PR creates the worktree from the PR head even when the head branch is not fetched", async ({
    page,
  }) => {
    test.skip(!hasGithubAuth(), "Requires GitHub authentication (gh auth login)");

    const ghRepo = await createTempGithubRepo({
      category: "new-workspace-pr-worktree",
      prs: [{ title: "Checkout PR worktree", state: "open" }],
    });
    const pr = ghRepo.prs[0]!;
    const mainCheckout = await cloneGithubRepoDefaultBranchOnly(ghRepo);

    try {
      const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await openStartingRefPicker(page);
      await selectGitHubPrInPicker(page, pr.number);
      await submitNewWorkspaceWithoutPrompt(page);

      const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId: getServerId(),
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(worktree.workspaceDirectory);

      const branchInfo = await readWorktreeBranchInfo({
        worktreePath: worktree.workspaceDirectory,
      });
      expect(branchInfo.currentBranch).toBe(pr.branch);
      expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(true);
    } finally {
      await mainCheckout.cleanup();
      await ghRepo.cleanup();
    }
  });
});
