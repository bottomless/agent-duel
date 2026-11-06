import { afterEach, describe, expect, it } from "vitest";
import {
  answerConfirmDialog,
  confirmDialog,
  confirmDialogWithChoice,
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

  it("resolves with the picked choice only when the user confirms", async () => {
    mountHost();
    const choices = { label: "Why?", options: [{ id: "both_wrong", label: "Both wrong" }] };
    const picked = confirmDialogWithChoice({ title: "Discard?", message: "Gone.", choices });
    answerConfirmDialog(activeRequest()!.id, true, "both_wrong");
    await expect(picked).resolves.toEqual({ confirmed: true, choice: "both_wrong" });

    const unanswered = confirmDialogWithChoice({ title: "Discard?", message: "Gone.", choices });
    answerConfirmDialog(activeRequest()!.id, true);
    await expect(unanswered).resolves.toEqual({ confirmed: true });

    const cancelled = confirmDialogWithChoice({ title: "Discard?", message: "Gone.", choices });
    answerConfirmDialog(activeRequest()!.id, false, "both_wrong");
    await expect(cancelled).resolves.toEqual({ confirmed: false });
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

  it("cancels an obsolete early pick without answering another dialog", async () => {
    mountHost();
    const turn = new AbortController();
    const early = confirmDialog({ title: "Choose A early", message: "B is working" }, turn.signal);
    const earlyId = activeRequest()!.id;
    const other = confirmDialog({ title: "Other action", message: "Unrelated" });

    turn.abort();
    await expect(early).resolves.toBe(false);
    expect(activeRequest()?.title).toBe("Other action");
    answerConfirmDialog(earlyId, true);
    expect(activeRequest()?.title).toBe("Other action");
    answerConfirmDialog(activeRequest()!.id, true);
    await expect(other).resolves.toBe(true);
  });

  it("does not queue a confirmation for an already obsolete turn", async () => {
    mountHost();
    const turn = new AbortController();
    turn.abort();
    await expect(
      confirmDialog({ title: "Early pick", message: "Old turn" }, turn.signal),
    ).resolves.toBe(false);
    expect(activeRequest()).toBeNull();
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
