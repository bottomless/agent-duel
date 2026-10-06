import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  connectNewWorkspaceDaemonClient,
  expectNewWorkspaceControlsEnabled,
  expectNewWorkspaceProjectSelected,
  openGlobalNewWorkspaceComposer,
  openMissingProjectNewWorkspaceComposer,
  openNewWorkspaceComposer,
  openNewWorkspaceProjectPickerWithShortcut,
} from "../support/helpers/new-workspace";
import { addProjectFlow, expectAddProjectPage } from "../support/helpers/add-project-flow";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import {
  clickArchiveWorkspaceMenuItem,
  expectWorkspaceAbsentFromSidebar,
} from "../support/helpers/sidebar";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

// Model B entry points into the New Workspace screen. Cmd/Ctrl+N remains the
// app-wide composer shortcut, while each project's per-row New chat icon opens
// the composer with that project preselected. Projects are added from the
// persistent Add project action in the sidebar footer.

function projectRow(page: import("@playwright/test").Page, projectKey: string) {
  return page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(projectKey)}`);
}

test.describe("New workspace entry points", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    await client?.close().catch(() => undefined);
  });

  test("only the sidebar footer exposes the Add Project flow", async ({ page }) => {
    const seeded: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-global-button-" });

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: "localhost",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: "secondary-new-workspace-host",
          label: "Secondary host",
          endpoint: "127.0.0.1:9",
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: seeded.workspaceId,
      });

      await expect(page.getByTestId("sidebar-global-new-workspace")).toHaveCount(0);
      await expect(page.getByText("Workspaces", { exact: true })).toHaveCount(0);

      const addProjectButton = page.getByTestId("sidebar-add-project");
      await expect(addProjectButton).toBeVisible({ timeout: 30_000 });
      await expect(addProjectButton).toContainText("Add project");
      await addProjectButton.click();
      await expect(addProjectFlow(page)).toBeVisible({ timeout: 30_000 });
      await expectAddProjectPage(page, "method");
      await expect(page).not.toHaveURL(/\/new(?:\?.*)?$/);
    } finally {
      await seeded.cleanup();
    }
  });

  test("the New Workspace screen hides the host selector when there is only one host", async ({
    page,
  }) => {
    const seeded: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-single-host-" });

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: "localhost",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });

      await openGlobalNewWorkspaceComposer(page);

      await expect(page.getByTestId("new-workspace-project-picker-trigger")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("host-picker-trigger")).toHaveCount(0);
    } finally {
      await seeded.cleanup();
    }
  });

  test("a stale project route keeps the New Workspace controls enabled", async ({ page }) => {
    await gotoAppShell(page);
    await openMissingProjectNewWorkspaceComposer(page, {
      serverId: getServerId(),
      projectId: "missing-project",
      sourceDirectory: "/tmp/missing-project",
    });

    await expectNewWorkspaceControlsEnabled(page);
  });

  test("Ctrl+P opens the project picker with search focused", async ({ page }) => {
    const seeded: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-shortcut-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);

      await openNewWorkspaceProjectPickerWithShortcut(page);
    } finally {
      await seeded.cleanup();
    }
  });

  test("keeps the in-progress form when the remembered workspace is archived elsewhere", async ({
    page,
  }) => {
    const otherProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "aa-new-workspace-archive-other-",
    });
    const rememberedProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "zz-new-workspace-archive-remembered-",
    });
    const serverId = getServerId();
    const draftText = "keep this new workspace draft";

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId,
          label: "localhost",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await page
        .getByTestId(`sidebar-workspace-row-${serverId}:${rememberedProject.workspaceId}`)
        .click();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });

      await page.goto(`/new?serverId=${encodeURIComponent(serverId)}`);
      await expectNewWorkspaceProjectSelected(page, rememberedProject.projectDisplayName);

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeEditable({ timeout: 30_000 });
      await composer.fill(draftText);
      await expect(composer).toHaveValue(draftText);

      await clickArchiveWorkspaceMenuItem(page, rememberedProject.workspaceId);
      await expectWorkspaceAbsentFromSidebar(page, rememberedProject.workspaceId);

      await expect(page).toHaveURL(/\/new(?:\?.*)?$/, { timeout: 30_000 });
      await expect(composer).toHaveValue(draftText);
      await expectNewWorkspaceProjectSelected(page, rememberedProject.projectDisplayName);
    } finally {
      await otherProject.cleanup();
      await rememberedProject.cleanup();
    }
  });

  test("each project's row icon preselects that project, and the reused screen resets a stale manual choice across projects", async ({
    page,
  }) => {
    const projectA: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-preselect-a-" });
    const projectB: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-preselect-b-" });
    const projectC: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-preselect-c-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(projectRow(page, projectA.projectKey)).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, projectB.projectKey)).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, projectC.projectKey)).toBeVisible({ timeout: 30_000 });

      // Project A's row icon opens New Workspace with A preselected.
      await openNewWorkspaceComposer(page, {
        projectKey: projectA.projectKey,
        projectDisplayName: projectA.projectDisplayName,
      });
      await expectNewWorkspaceProjectSelected(page, projectA.projectDisplayName);

      // Manually override the selection to C from inside A's screen. This stale
      // manualProjectKey is what the reused 'new' screen must reset when the next
      // route-driven navigation targets a different project.
      await page.getByTestId("new-workspace-project-picker-trigger").click();
      const optionC = page.getByTestId(
        `new-workspace-project-picker-option-${projectEquivalenceViewKey(projectC.projectKey)}`,
      );
      await expect(optionC).toBeVisible({ timeout: 30_000 });
      await optionC.click();
      await expectNewWorkspaceProjectSelected(page, projectC.projectDisplayName);

      // Navigate via B's row icon. B must be preselected — the route project wins
      // because the stale manual choice (C) was reset on the route change. If the
      // reset were missing, the trigger would still read C.
      await openNewWorkspaceComposer(page, {
        projectKey: projectB.projectKey,
        projectDisplayName: projectB.projectDisplayName,
      });
      await expectNewWorkspaceProjectSelected(page, projectB.projectDisplayName);
    } finally {
      await projectA.cleanup();
      await projectB.cleanup();
      await projectC.cleanup();
    }
  });

  test("only worktree-capable projects can be selected and isolation is implicit", async ({
    page,
  }) => {
    const gitProject: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-iso-git-" });
    const nonGitProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "entry-iso-nongit-",
      git: false,
    });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(projectRow(page, gitProject.projectKey)).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, nonGitProject.projectKey)).toBeVisible({ timeout: 30_000 });

      // Non-git projects remain visible for context but cannot be selected.
      await openGlobalNewWorkspaceComposer(page);
      const trigger = page.getByTestId("new-workspace-project-picker-trigger");
      await expect(trigger).toBeVisible({ timeout: 30_000 });
      await trigger.click();
      const nonGitOption = page.getByTestId(
        `new-workspace-project-picker-option-${projectEquivalenceViewKey(nonGitProject.projectKey)}`,
      );
      await expect(nonGitOption).toBeVisible({ timeout: 30_000 });
      await expect(nonGitOption).toHaveAttribute("aria-disabled", "true");

      // A git project can be selected, and worktree isolation is implicit.
      const gitOption = page.getByTestId(
        `new-workspace-project-picker-option-${projectEquivalenceViewKey(gitProject.projectKey)}`,
      );
      await expect(gitOption).toBeVisible({ timeout: 30_000 });
      await gitOption.click();
      await expectNewWorkspaceProjectSelected(page, gitProject.projectDisplayName);
      await expect(page.getByTestId("workspace-create-isolation-trigger")).toHaveCount(0);
    } finally {
      await gitProject.cleanup();
      await nonGitProject.cleanup();
    }
  });
});
