/**
 * @vitest-environment jsdom
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ArenaPartSourceContext, useFullToolPart } from "./full-tool-part";

const arenaRunPart = vi.hoisted(() => vi.fn());

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({ sessions: { server: { client: { arenaRunPart } } } }),
}));

const shortened = {
  id: "call",
  sessionID: "ses",
  messageID: "msg",
  type: "tool",
  tool: "bash",
  state: {
    status: "completed",
    output: "start … 36000 more characters … end",
    previewed: ["output"],
  },
};
const whole = { ...shortened, state: { status: "completed", output: "x".repeat(40_000) } };

function render(part: Record<string, unknown>, opened: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        ArenaPartSourceContext.Provider,
        { value: { serverId: "server", agentId: "agent" } },
        children,
      ),
    );
  return renderHook(({ shown }) => useFullToolPart(shown, "run", opened), {
    wrapper,
    initialProps: { shown: part },
  });
}

describe("a shortened tool call", () => {
  it("shows the preview until it is opened, then the whole part", async () => {
    arenaRunPart.mockReset().mockResolvedValue(whole);
    expect(render(shortened, false).result.current).toBe(shortened);
    expect(arenaRunPart).not.toHaveBeenCalled();

    const opened = render(shortened, true);
    await waitFor(() => expect(opened.result.current).toEqual(whole));
    // Its session and message let the engine read the one row.
    expect(arenaRunPart).toHaveBeenCalledWith("agent", "run", "call", {
      sessionId: "ses",
      messageId: "msg",
    });
  });

  it("keeps the preview of a running call, whose end is its latest output", () => {
    arenaRunPart.mockReset();
    const running = { ...shortened, state: { ...shortened.state, status: "running" } };
    expect(render(running, true).result.current).toBe(running);
    expect(arenaRunPart).not.toHaveBeenCalled();
  });

  it("never asks for a call that was sent whole", () => {
    arenaRunPart.mockReset();
    const sent = { ...whole };
    expect(render(sent, true).result.current).toBe(sent);
    expect(arenaRunPart).not.toHaveBeenCalled();
  });
});
