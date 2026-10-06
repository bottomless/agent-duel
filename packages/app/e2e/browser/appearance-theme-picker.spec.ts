import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsSection } from "../support/helpers/settings";

test("shows Pure black in the appearance picker", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const themeTrigger = page.getByLabel("Theme: System", { exact: true });
  await themeTrigger.click();
  await expect(page.getByText("Pure black", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("appearance-theme-picker.png"),
    fullPage: true,
  });
});

test("keeps the selected workspace visible in Pure black", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "pure-black-selected-workspace-",
    title: "Selected workspace",
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "pureBlack" }));
    });
    await gotoAppShell(page);

    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveCSS("background-color", "rgb(22, 22, 22)");
    await page.screenshot({
      path: testInfo.outputPath("pure-black-selected-workspace.png"),
      fullPage: true,
    });
  } finally {
    await workspace.cleanup();
  }
});

test("applies the interface font size to settings text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ uiFontSize: 24 }));
  });
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const sectionTitle = page.getByText("Theme", { exact: true }).first();
  await expect(sectionTitle).toHaveCSS("font-size", "18px");

  const fontSizeInput = page.getByLabel("Interface font size");
  await expect(fontSizeInput).toHaveValue("24");
  await fontSizeInput.fill("12");
  await fontSizeInput.press("Tab");

  await expect(fontSizeInput).toHaveValue("12");
  await expect(sectionTitle).toHaveCSS("font-size", "9px");
});

test("keeps an invalid font size for correction and preserves focus after saving", async ({
  page,
}) => {
  await page.goto("/settings");
  await openSettingsSection(page, "appearance");
  const input = page.getByLabel("Interface font size", { exact: true });
  await input.fill("99");
  await input.press("Tab");
  await expect(input).toHaveValue("99");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Enter a whole number from 11 to 24 px", { exact: true }),
  ).toBeVisible();
  await input.fill("18");
  await input.press("Enter");
  await expect(input).toHaveValue("18");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "false");
});

test("searches setting names and filters the actual controls", async ({ page }) => {
  await page.goto("/settings");
  await openSettingsSection(page, "general");
  const search = page.getByRole("textbox", { name: "Search settings", exact: true });
  await search.fill("code font");
  const results = page.getByTestId("settings-search-results");
  await expect(results.getByLabel("Code font family", { exact: true })).toBeVisible();
  await expect(results.getByLabel("Interface font family", { exact: true })).toHaveCount(0);
  await expect(results.getByText("Theme", { exact: true })).toHaveCount(0);
  await search.fill("no-such-setting-xyz");
  await expect(results.getByText("No matching settings", { exact: true })).toBeVisible();
  await search.clear();
  await expect(page.getByTestId("settings-search-results")).toHaveCount(0);
  await expect(page.getByText("Default send", { exact: true })).toBeVisible();
});
