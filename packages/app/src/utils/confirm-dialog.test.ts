import { afterEach, describe, expect, it } from "vitest";
import {
  answerConfirmDialog,
  confirmDialog,
  registerConfirmDialogHost,
  selectActiveConfirmDialog,
  useConfirmDialogStore,
} from "./confirm-dialog";

const unregisterHosts: Array<() => void> = [];

function mountHost(): () => void {
  const unregister = registerConfirmDialogHost();
  unregisterHosts.push(unregister);
  return unregister;
}

function activeRequest() {
  return selectActiveConfirmDialog(useConfirmDialogStore.getState());
}

describe("confirmDialog", () => {
  afterEach(() => {
    for (const unregister of unregisterHosts.splice(0)) unregister();
  });

  it("rejects when no host is mounted, instead of waiting forever", async () => {
    await expect(confirmDialog({ title: "Restart host", message: "Restarts it." })).rejects.toThrow(
      "[ConfirmDialog] No confirm dialog host is mounted.",
    );
  });

  it("shows the request and resolves with the user's answer", async () => {
    mountHost();
    const answer = confirmDialog({
      title: "Discard this battle?",
      message: "Both agents' work from this turn will be discarded.",
      confirmLabel: "Discard battle",
      destructive: true,
    });

    const request = activeRequest();
    expect(request).toMatchObject({
      title: "Discard this battle?",
      confirmLabel: "Discard battle",
      destructive: true,
    });

    answerConfirmDialog(request!.id, true);
    await expect(answer).resolves.toBe(true);
    expect(activeRequest()).toBeNull();
  });

  it("shows a second request only after the first is answered", async () => {
    mountHost();
    const first = confirmDialog({ title: "First", message: "1" });
    const second = confirmDialog({ title: "Second", message: "2" });

    expect(activeRequest()?.title).toBe("First");
    answerConfirmDialog(activeRequest()!.id, false);
    await expect(first).resolves.toBe(false);

    expect(activeRequest()?.title).toBe("Second");
    answerConfirmDialog(activeRequest()!.id, true);
    await expect(second).resolves.toBe(true);
  });

  it("ignores a second answer to the same request", async () => {
    mountHost();
    const answer = confirmDialog({ title: "Close tabs?", message: "Closes 2 tabs." });
    const id = activeRequest()!.id;

    answerConfirmDialog(id, false);
    answerConfirmDialog(id, true);
    await expect(answer).resolves.toBe(false);
  });

  it("cancels whatever is waiting when the last host unmounts", async () => {
    const unregisterFirst = mountHost();
    const unregisterSecond = mountHost();
    const answer = confirmDialog({ title: "Remove project?", message: "Removes it." });

    unregisterFirst();
    expect(activeRequest()?.title).toBe("Remove project?");

    unregisterSecond();
    await expect(answer).resolves.toBe(false);
    expect(activeRequest()).toBeNull();
  });
});
