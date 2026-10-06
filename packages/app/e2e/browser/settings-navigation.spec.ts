import { test, expect } from "../support/fixtures";
import {
  buildOpenProjectRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
} from "@/utils/host-routes";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import {
  openSettingsSection,
  expectSettingsHeader,
  openAddHostFlow,
  selectHostConnectionType,
  toggleHostAdvanced,
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
  expectAddHostMethodOptions,
  fillDirectHostUri,
  expectDirectHostFormValues,
  expectDirectHostSslEnabled,
  expectDirectHostUriValue,
  expectDirectHostUriHidden,
  expectGeneralContent,
  expectAppearanceContent,
} from "../support/helpers/settings";
import { expectAppRoute } from "../support/helpers/route-assertions";

test.describe("Settings sidebar navigation", () => {
  test("clicking a sidebar section updates the URL and renders the section", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await openSettingsSection(page, "general");
    await expectSettingsHeader(page, "General");
    await expectGeneralContent(page);

    await openSettingsSection(page, "appearance");
    await expectSettingsHeader(page, "Appearance");
    await expectAppearanceContent(page);
  });

  test("/h/[serverId]/settings redirects to the host connections section", async ({ page }) => {
    await gotoAppShell(page);
    await verifyLegacyHostSettingsRedirect(page);
  });

  test("the + Add host button opens the add-host method modal", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openAddHostFlow(page);
    await expectAddHostMethodOptions(page);
  });

  test("direct connection advanced URI round-trips SSL and password into the form", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openAddHostFlow(page);
    await selectHostConnectionType(page, "direct");

    await toggleHostAdvanced(page);
    await fillDirectHostUri(page, "tcp://example.paseo.test:7443?ssl=true&password=shared-secret");
    await toggleHostAdvanced(page);

    await expectDirectHostFormValues(page, {
      host: "example.paseo.test",
      port: "7443",
      password: "shared-secret",
    });
    await expectDirectHostSslEnabled(page);
    await expectDirectHostUriHidden(page);

    await toggleHostAdvanced(page);
    await expectDirectHostUriValue(
      page,
      "tcp://example.paseo.test:7443?ssl=true&password=shared-secret",
    );
    await toggleHostAdvanced(page);
    await expectDirectHostUriHidden(page);
  });

  test("sidebar shows a Back to workspace row that leaves /settings", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await clickSettingsBackToWorkspace(page);
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });
});

test.describe("Settings — compact master-detail", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("/settings renders only the sidebar list (no section content)", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await expectSettingsSidebarSections(page, ["general", "appearance"]);
    await expectCompactSettingsList(page);

    await expectSettingsBackButton(page);
    await goBackInSettings(page);
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });

  test("tapping a section pushes /settings/[section] and shows a back button", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await openSettingsSection(page, "appearance");
    await expectAppRoute(page, buildSettingsSectionRoute("appearance"));
    await expectAppearanceContent(page);
    await expectSettingsSidebarHidden(page);
    await expectSettingsBackButton(page);
  });

  test("back from a section detail returns to the /settings list", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await openSettingsSection(page, "appearance");
    await expectAppRoute(page, buildSettingsSectionRoute("appearance"));

    await goBackInSettings(page);
    await expectCompactSettingsList(page);
    await expectSettingsBackButton(page);
  });

  test("tapping a host section row opens the host detail", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await openCompactSettingsHost(page);
    await expectSettingsBackButton(page);
    await expectSettingsSidebarHidden(page);
  });

  test("back from a host detail returns to the /settings list", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await openCompactSettingsHost(page);
    await goBackInSettings(page);
    await expectAppRoute(page, buildSettingsRoute());
    await expectSettingsSidebarVisible(page);
  });
});
