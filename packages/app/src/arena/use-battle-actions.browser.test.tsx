import React, { act, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import type { ToastApi } from "@/components/toast-host";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import {
  answerConfirmDialog,
  registerConfirmDialogHost,
  selectActiveConfirmDialog,
  useConfirmDialogStore,
} from "@/utils/confirm-dialog";
import { useArenaBattleActions } from "./use-battle-actions";

vi.mock("react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native")>()),
  ToastAndroid: {
    SHORT: 0,
    LONG: 1,
    TOP: 49,
    showWithGravity: vi.fn(),
  },
}));

type Turn = NonNullable<ArenaSnapshot["turn"]>;

const toast: ToastApi = {
  show: () => () => {},
  copied: () => {},
  error: () => {},
};

function EarlyPick({ turn }: { turn: Turn }) {
  const actions = useArenaBattleActions("server", "agent", turn);
  const pickEarly = actions.pickEarly;
  const pick = useCallback(() => void pickEarly("a"), [pickEarly]);
  return (
    <button type="button" onClick={pick}>
      Choose A early
    </button>
  );
}

function runningTurn(): Turn {
  return {
    id: "turn-1",
    index: 0,
    state: "running",
    prompt: "Read the project",
    baseSHA: "base",
    comparisonState: "pending",
    canVote: false,
    canTie: false,
    canDiscardBattle: false,
    canResumeBattle: false,
    canRetryResolution: false,
    revealed: false,
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
  };
}

describe("early-pick confirmation lifetime", () => {
  it.each(["awaiting_vote", "awaiting_stop_resolution", "applying"] as const)(
    "closes without voting when the turn becomes %s",
    async (state) => {
      vi.stubGlobal("React", React);
      await i18n.changeLanguage("en");
      const unregister = registerConfirmDialogHost();
      const queryClient = new QueryClient();
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const turn = runningTurn();
      const render = (current: Turn) =>
        act(() =>
          root.render(
            <QueryClientProvider client={queryClient}>
              <ToastApiProvider api={toast}>
                <EarlyPick turn={current} />
              </ToastApiProvider>
            </QueryClientProvider>,
          ),
        );
      try {
        render(turn);
        act(() => container.querySelector("button")!.click());
        const request = selectActiveConfirmDialog(useConfirmDialogStore.getState());
        expect(request?.title).toContain("A");
        render({ ...turn, state });
        expect(selectActiveConfirmDialog(useConfirmDialogStore.getState())).toBeNull();
        answerConfirmDialog(request!.id, true);
        await act(async () => {});
        expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
      } finally {
        act(() => root.unmount());
        container.remove();
        unregister();
        queryClient.clear();
        vi.unstubAllGlobals();
      }
    },
  );
});
