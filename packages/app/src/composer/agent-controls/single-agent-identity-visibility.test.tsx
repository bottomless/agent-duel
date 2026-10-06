/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { useVisibleSingleAgentIdentity } from "./single-agent-identity-visibility";

describe("useVisibleSingleAgentIdentity", () => {
  it("removes the old identity while a pass runs and waits for the completed pass snapshot", async () => {
    const first = {
      id: "rating-1",
      revealed: true,
      vote: "up",
      identity: { name: "First agent" },
    } as const;
    const second = { id: "rating-2", revealed: false } as const;
    let finishFreshRefetch:
      | ((value: { isError: boolean; data?: ArenaSnapshot }) => void)
      | undefined;
    const refetch = vi
      .fn<() => Promise<{ isError: boolean; data?: ArenaSnapshot }>>()
      .mockResolvedValueOnce({
        isError: false,
        data: { singleAgent: first } as ArenaSnapshot,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFreshRefetch = resolve;
          }),
      );
    const view = renderHook(
      ({ status, singleAgent }) => useVisibleSingleAgentIdentity(status, singleAgent, refetch),
      {
        initialProps: {
          status: "idle" as AgentLifecycleStatus,
          singleAgent: first as ArenaSnapshot["singleAgent"],
        },
      },
    );

    expect(view.result.current).toEqual(first);
    view.rerender({ status: "running", singleAgent: first });
    expect(view.result.current).toBeUndefined();
    view.rerender({ status: "idle", singleAgent: first });
    expect(view.result.current).toBeUndefined();
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(2));
    expect(view.result.current).toBeUndefined();

    view.rerender({ status: "idle", singleAgent: second });
    await waitFor(() => expect(view.result.current).toEqual(second));
    await act(async () =>
      finishFreshRefetch?.({ isError: false, data: { singleAgent: second } as ArenaSnapshot }),
    );
  });
});
