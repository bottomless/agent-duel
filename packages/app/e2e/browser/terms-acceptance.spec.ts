import { expect, test } from "../support/fixtures";
import type { AccountUser, LegalDocuments } from "@getpaseo/protocol/accounts/schemas";

const documents: LegalDocuments = {
  termsVersion: "terms-v1",
  termsUrl: "https://policies.example/terms/v1",
  privacyPolicyVersion: "privacy-v1",
  privacyPolicyUrl: "https://policies.example/privacy/v1",
};
const user: AccountUser = {
  id: "terms-test",
  email: "terms@example.com",
  name: "Terms Test",
  image: null,
};

// The real renderer and isolated daemon run normally. Only the hosted accounts HTTP
// boundary is controlled: OAuth credentials and a live cloud database are not needed
// to inject save failures or prove the UI's acceptance/retry behavior. Daemon proxy
// behavior is covered separately by accounts/routes.test.ts over real HTTP.
test("points every sign-in button at the unchecked agreement", async ({
  page,
  context,
}, testInfo) => {
  await page.route("**/api/auth/methods", (route) =>
    route.fulfill({
      json: { enabled: true, methods: ["email", "google", "github"], legal: documents },
    }),
  );
  await context.route("https://policies.example/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Policy fixture</h1>" }),
  );
  let flowRequests = 0;
  await page.route("**/api/auth/flow", async (route) => {
    flowRequests += 1;
    expect(route.request().postDataJSON().acceptance).toEqual({
      accepted: true,
      termsVersion: documents.termsVersion,
      privacyPolicyVersion: documents.privacyPolicyVersion,
    });
    await route.fulfill({
      json: { flowId: "flow", secret: "secret", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
  });
  await page.route("**/api/auth/magic-link", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/auth/flow/claim", (route) =>
    route.fulfill({ json: { status: "pending" } }),
  );
  await page.goto("/");
  await page.getByTestId("sign-in-email-input").fill("terms@example.com");
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByTestId("legal-checkbox-error")).toHaveCount(0);
  for (const testId of ["sign-in-send-link", "sign-in-google", "sign-in-github"]) {
    await page.getByTestId(testId).click();
    await expect(page.getByTestId("legal-checkbox-error")).toHaveText(
      "Agree to the Terms of Service to continue.",
    );
    await expect(page.getByRole("checkbox")).toBeFocused();
  }
  expect(flowRequests).toBe(0);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Terms of Service", exact: true }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(documents.termsUrl);
  await popup.close();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await testInfo.attach("login", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("checkbox").click();
  await expect(page.getByTestId("legal-checkbox-error")).toHaveCount(0);
  await page.getByTestId("sign-in-send-link").click();
  await expect(page.getByText("Check your inbox", { exact: true })).toBeVisible();
});

test("blocks an existing account, retries saving, survives reload, and asks again for new versions", async ({
  page,
}, testInfo) => {
  let currentDocuments = documents;
  let account = user;
  let saves = 0;
  let releaseSave: () => void = () => {};
  const saveBarrier = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.addInitScript(
    ({ user: initialUser }) => {
      if (!localStorage.getItem("terms-fixture-seeded")) {
        localStorage.setItem(
          "agent-duel-account-session",
          JSON.stringify({
            state: { session: { token: "test-session", user: initialUser, method: "email" } },
            version: 1,
          }),
        );
        localStorage.setItem("terms-fixture-seeded", "true");
      }
    },
    { user },
  );
  await page.route("**/api/auth/methods", (route) =>
    route.fulfill({ json: { enabled: true, methods: ["email"], legal: currentDocuments } }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { user: account, method: "email" } }),
  );
  await page.route("**/api/auth/sign-out", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/auth/accept-terms", async (route) => {
    saves += 1;
    expect(route.request().headers()["x-paseo-session"]).toBe("test-session");
    expect(route.request().postDataJSON()).toEqual({
      accepted: true,
      termsVersion: documents.termsVersion,
      privacyPolicyVersion: documents.privacyPolicyVersion,
    });
    if (saves === 1) {
      await route.fulfill({
        status: 503,
        json: { error: "Could not save acceptance. Please try again." },
      });
      return;
    }
    await saveBarrier;
    account = {
      ...user,
      legalAcceptance: {
        termsVersion: documents.termsVersion,
        privacyPolicyVersion: documents.privacyPolicyVersion,
        acceptedAt: "2026-10-15T12:00:00.000Z",
      },
    };
    await route.fulfill({ json: { user: account, method: "email" } });
  });
  await page.goto("/");
  const modal = page.getByTestId("terms-acceptance-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("open-project-submit")).toHaveCount(0);
  await expect(page.getByTestId("accept-terms")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible();
  await page.getByRole("checkbox").click();
  await page.getByTestId("accept-terms").click();
  await expect(page.getByRole("alert")).toContainText("Could not save acceptance");
  await testInfo.attach("acceptance-error", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.getByTestId("accept-terms").click();
  await expect(page.getByTestId("accept-terms")).toBeDisabled();
  releaseSave();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId("open-project-submit")).toBeVisible();
  expect(saves).toBe(2);
  await page.reload();
  await expect(page.getByTestId("open-project-submit")).toBeVisible();
  await expect(modal).toHaveCount(0);
  currentDocuments = {
    ...documents,
    termsVersion: "terms-v2",
    termsUrl: "https://policies.example/terms/v2",
  };
  await page.reload();
  await expect(modal).toBeVisible();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByTestId("sign-in-email-input")).toBeVisible();
  expect(saves).toBe(2);
});
