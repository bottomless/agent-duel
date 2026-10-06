import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaSessionQueryKey, replaceArenaSessionSnapshot } from "./use-arena-session";

describe("replaceArenaSessionSnapshot", () => {
  it("prevents an older poll from restoring the vote UI after resolution", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = arenaSessionQueryKey("server-1", "agent-1");
    const staleSnapshot = { chat: { status: "battle_active" } } as ArenaSnapshot;
    const resolvedSnapshot = { chat: { status: "ready" } } as ArenaSnapshot;
    let resolvePoll!: (snapshot: ArenaSnapshot) => void;
    const poll = queryClient
      .fetchQuery({
        queryKey,
        queryFn: () =>
          new Promise<ArenaSnapshot>((resolve) => {
            resolvePoll = resolve;
          }),
      })
      .catch(() => undefined);

    await Promise.resolve();
    await replaceArenaSessionSnapshot({
      queryClient,
      serverId: "server-1",
      agentId: "agent-1",
      snapshot: resolvedSnapshot,
    });
    resolvePoll(staleSnapshot);
    await poll;

    expect(queryClient.getQueryData(queryKey)).toBe(resolvedSnapshot);
  });

  it("publishes the vote acknowledgement before polling cancellation settles", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = arenaSessionQueryKey("server-1", "agent-1");
    const acknowledged = { chat: { status: "battle_active" } } as ArenaSnapshot;
    const cancellation = Promise.withResolvers<void>();
    vi.spyOn(queryClient, "cancelQueries").mockReturnValue(cancellation.promise);

    const replacement = replaceArenaSessionSnapshot({
      queryClient,
      serverId: "server-1",
      agentId: "agent-1",
      snapshot: acknowledged,
    });

    expect(queryClient.getQueryData(queryKey)).toBe(acknowledged);
    cancellation.resolve();
    await replacement;
    expect(queryClient.getQueryData(queryKey)).toBe(acknowledged);
  });
});
