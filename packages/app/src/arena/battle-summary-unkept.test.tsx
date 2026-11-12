/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaHistoryItem } from "@getpaseo/protocol/arena/rpc-schemas";

vi.stubGlobal("React", React);

// The shown battle loads its runs over the daemon; this suite is about the collapsed line.
vi.mock("./run-thread", () => ({ ArenaRunThread: () => null }));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), show: vi.fn() }),
}));

import { ArenaBattleSummary } from "./battle-summary";
import { useArenaShownBattleStore } from "./shown-battle";

function TestQueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const discarded = {
  id: "turn-1",
  index: 0,
  state: "discarded",
  resolution: { kind: "stopped", resolution: "discard" },
  identities: { a: { name: "Qwen 3.8 Max" }, b: { name: "GLM 5.3 FlashX" } },
} as unknown as ArenaHistoryItem;

afterEach(() => {
  cleanup();
  useArenaShownBattleStore.setState({ byAgent: {} });
});

describe("a battle that kept no answer", () => {
  it("says so in a line with both models, not in a card", () => {
    const view = render(
      <ArenaBattleSummary serverId="s" workspaceId="w" agentId="agent" item={discarded} />,
      { wrapper: TestQueryProvider },
    );
    const line = view.getByTestId("arena-unkept-turn-1");
    expect(line.textContent).toContain("Battle discarded");
    expect(line.textContent).toContain("Qwen 3.8 Max");
    expect(line.textContent).toContain("GLM 5.3 FlashX");
    // No header to expand: the battle opens from Show battle, as a kept answer's does.
    expect(view.queryByRole("button", { expanded: false })).toBeNull();

    fireEvent.click(view.getByTestId("arena-show-battle-turn-1"));
    expect(useArenaShownBattleStore.getState().byAgent.agent).toBe("turn-1");
  });
});
