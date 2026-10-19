import { expect, type Locator, type Page } from "@playwright/test";

/** The in-app modal that `confirmDialog` opens (`components/confirm-dialog-host.tsx`). */
export function confirmDialogLocator(page: Page): Locator {
  return page.getByRole("alertdialog");
}

export interface ConfirmDialogText {
  title: string;
  message: string;
}

/** Waits for the confirm dialog and returns what it asks. */
export async function readConfirmDialog(page: Page): Promise<ConfirmDialogText> {
  const dialog = confirmDialogLocator(page);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  return {
    title: (await dialog.getByTestId("confirm-dialog-title").textContent()) ?? "",
    message: (await dialog.getByTestId("confirm-dialog-message").textContent()) ?? "",
  };
}

/** Answers the confirm dialog, waits for it to close, and returns what it asked. */
export async function answerConfirmDialog(
  page: Page,
  answer: "confirm" | "cancel",
): Promise<ConfirmDialogText> {
  const text = await readConfirmDialog(page);
  const dialog = confirmDialogLocator(page);
  await dialog
    .getByTestId(answer === "confirm" ? "confirm-dialog-confirm" : "confirm-dialog-cancel")
    .click();
  await expect(dialog).toHaveCount(0);
  return text;
}

/**
 * Confirms the dialog if one opens before `done` turns true, for actions that ask only in some
 * states (an archive asks only when the worktree has unsynced work).
 */
export async function confirmIfAsked(page: Page, done: () => Promise<boolean>): Promise<void> {
  const dialog = confirmDialogLocator(page);
  await expect
    .poll(async () => (await dialog.count()) > 0 || (await done()), { timeout: 30_000 })
    .toBe(true);
  if ((await dialog.count()) > 0) {
    await answerConfirmDialog(page, "confirm");
  }
}
