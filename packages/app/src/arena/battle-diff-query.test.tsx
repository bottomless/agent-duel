/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRefetchBattleDiffOnResult } from "./battle-diff-query";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Probe({ results }: { results: string }) {
  useRefetchBattleDiffOnResult("server-1", "agent-1", "turn-1", results);
  return null;
}

function render(results: string) {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe results={results} />
      </QueryClientProvider>,
    );
  });
}

describe("useRefetchBattleDiffOnResult", () => {
  it("reads the battle's list and file diffs again when a side's result lands", () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render("commit-a:");
    expect(invalidate).not.toHaveBeenCalled();
    render("commit-a:");
    expect(invalidate).not.toHaveBeenCalled();
    render("commit-a:commit-b");
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["arena", "diff", "server-1", "agent-1", "turn-1"],
      ["arena", "file-diff", "server-1", "agent-1", "turn-1"],
    ]);
  });
});
