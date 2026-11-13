import { test, expect } from "../support/fixtures";
import {
  buildOpenProjectRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
} from "@/utils/host-routes";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import {
  closeCompactSettings,
  openSettingsSection,
  expectSettingsHeader,
  openCompactSettings,
  expectCompactSettingsList,
  expectSettingsSidebarVisible,
  expectSettingsSidebarHidden,
  expectSettingsSidebarSections,
  goBackInSettings,
  expectSettingsBackButton,
  clickSettingsBackToWorkspace,
  verifyLegacyHostSettingsRedirect,
  openCompactSettingsHost,
  expectGeneralContent,
  expectAppearanceContent,
} from "../support/helpers/settings";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.describe("Settings sidebar navigation", () => {
  test("opening Settings closes the composer model selector until it is opened again", async ({
    page,
    withWorkspace,
  }, testInfo) => {
    const workspace = await withWorkspace({ prefix: "settings-model-selector-" });
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);

    const selector = page.getByTestId("combined-model-selector").filter({ visible: true });
    const popover = page.getByTestId("combobox-desktop-container");
    await selector.click();
    await expect(popover).toBeVisible();

    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+,`);
    await expect(page).toHaveURL(/\/settings\/general$/);
    await page.screenshot({ path: testInfo.outputPath("settings-after-model-selector.png") });
    await expect(popover).toHaveCount(0);

    await clickSettingsBackToWorkspace(page);
    await expect(selector).toBeVisible();
    await expect(popover).toHaveCount(0);

    await selector.click();
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
  });

  test("opening Settings closes an existing chat's model selector until it is opened again", async ({
    page,
  }, testInfo) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "settings-existing-model-",
      title: "Settings model selector",
    });
    try {
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });

      const selector = page.getByTestId("combined-model-selector").filter({ visible: true });
      const popover = page.getByTestId("combobox-desktop-container");
      await selector.click();
      await expect(popover).toBeVisible();

      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+,`);
      await expect(page).toHaveURL(/\/settings\/general$/);
      await page.screenshot({
        path: testInfo.outputPath("settings-after-existing-model-selector.png"),
      });
      await expect(popover).toHaveCount(0);

      await clickSettingsBackToWorkspace(page);
      await expect(selector).toBeVisible();
      await expect(popover).toHaveCount(0);

      await selector.click();
      await expect(popover).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("clicking a sidebar section updates the URL and renders the section", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await openSettingsSection(page, "general");
    await expectSettingsHeader(page, "General");
    await expectGeneralContent(page);

    await openSettingsSection(page, "appearance");
    await expectSettingsHeader(page, "Appearance");
    await expectAppearanceContent(page);

    await clickSettingsBackToWorkspace(page);
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });

  test("/h/[serverId]/settings redirects to the host connections section", async ({ page }) => {
    await gotoAppShell(page);
    await verifyLegacyHostSettingsRedirect(page);
  });

  test("Escape lets a settings dropdown close before leaving settings", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await test.step("a dropdown owns Escape", async () => {
      await openSettingsSection(page, "appearance");
      await page.getByLabel(/Highlight theme:/).click();
      await expect(page.getByRole("menuitem", { name: "GitHub", exact: true })).toBeVisible();

      await page.keyboard.press("Escape");

      await expect(page.getByRole("menuitem", { name: "GitHub", exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(/\/settings(\/|$)/);
    });

    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });
});

test.describe("Settings — compact master-detail", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the compact tab switcher reopens after Settings hides its workspace", async ({ page }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "settings-tab-switcher-",
      title: "Compact tab switcher",
    });
    try {
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });

      const switcher = page.getByTestId("workspace-tab-switcher-trigger").filter({ visible: true });
      const newAgent = page.getByTestId("workspace-tab-switcher-new-agent");
      await switcher.click();
      await expect(newAgent).toBeInViewport();

      // Navigate without dismissing the sheet through its backdrop first.
      await page
        .getByTestId("menu-button")
        .filter({ visible: true })
        .first()
        .dispatchEvent("click");
      await page.getByTestId("sidebar-settings").first().dispatchEvent("click");
      await expectAppRoute(page, buildSettingsRoute());
      await expect(newAgent).toHaveCount(0);

      await closeCompactSettings(page);
      await expect(switcher).toBeVisible();
      await expect(newAgent).toHaveCount(0);
      await switcher.click();
      await expect(newAgent).toBeInViewport();
    } finally {
      await workspace.cleanup();
    }
  });

  test("opens compact app and host details and returns through the settings list", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await expectSettingsSidebarSections(page, ["general", "appearance"]);
    await expectCompactSettingsList(page);

    await test.step("open app details and return to the list", async () => {
      await openSettingsSection(page, "appearance");
      await expectAppRoute(page, buildSettingsSectionRoute("appearance"));
      await expectAppearanceContent(page);
      await expectSettingsSidebarHidden(page);
      await expectSettingsBackButton(page);
      await goBackInSettings(page);
      await expectCompactSettingsList(page);
    });

    await test.step("open host details and return through the list", async () => {
      await openCompactSettingsHost(page);
      await expectSettingsBackButton(page);
      await expectSettingsSidebarHidden(page);
      await goBackInSettings(page);
      await expectAppRoute(page, buildSettingsRoute());
      await expectSettingsSidebarVisible(page);
      await expectSettingsBackButton(page);
      await goBackInSettings(page);
      await expect(page).not.toHaveURL(/\/settings(\/|$)/);
    });
  });
});

async function measureDockedNavigation(page: import("@playwright/test").Page, width: number) {
  await page.setViewportSize({ width, height: 951 });
  const settings = page
    .getByRole("button", { name: "Settings", exact: true })
    .filter({ visible: true });
  await expect(settings).toBeVisible();
  return {
    width,
    settings: await settings.evaluate((el) => el.getBoundingClientRect().height),
  };
}

async function measureSettingsSplit(page: import("@playwright/test").Page, width: number) {
  await page.setViewportSize({ width, height: 951 });
  const sidebar = page.getByTestId("settings-sidebar");
  const detail = page.getByTestId("settings-detail-pane");
  await expect(sidebar).toBeVisible();
  await expect(detail).toBeVisible();
  return {
    width,
    sidebar: await sidebar.evaluate((el) => el.getBoundingClientRect().width),
    detail: await detail.evaluate((el) => el.getBoundingClientRect().width),
  };
}

async function expectConsistentDockedNavigation(page: import("@playwright/test").Page) {
  const wide = await measureDockedNavigation(page, 951);
  for (const width of [600, 669, 719, 720]) {
    const narrow = await measureDockedNavigation(page, width);
    expect
      .soft(narrow.settings, `Settings keeps its wide-layout density at ${width}`)
      .toBeCloseTo(wide.settings, 0);
  }
}

async function expectSettingsDetailKeepsReadingWidth(page: import("@playwright/test").Page) {
  const reference = await measureSettingsSplit(page, 720);
  for (const width of [600, 669, 719]) {
    const narrow = await measureSettingsSplit(page, width);
    expect
      .soft(narrow.detail, `Settings preserves its detail budget at ${width}`)
      .toBeGreaterThanOrEqual(reference.detail);
    expect
      .soft(narrow.sidebar, `Settings navigation yields width at ${width}`)
      .toBeLessThan(reference.sidebar);
  }
  const wide = await measureSettingsSplit(page, 951);
  expect(wide.sidebar).toBeCloseTo(reference.sidebar, 0);
  expect(wide.detail).toBeGreaterThan(reference.detail);
}

test("docked navigation keeps its density and Settings preserves reading width", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "narrow-wide-layout-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await expectConsistentDockedNavigation(page);
  await openSettings(page);
  await openSettingsSection(page, "appearance");
  await expectAppearanceContent(page);
  await expectSettingsDetailKeepsReadingWidth(page);
  await page.setViewportSize({ width: 599, height: 951 });
  await expectSettingsSidebarHidden(page);
  await expectAppearanceContent(page);
});
