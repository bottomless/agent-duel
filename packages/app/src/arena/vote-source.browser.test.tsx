import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text, type GestureResponderEvent } from "react-native";
import type { ArenaVoteSource } from "@getpaseo/protocol/arena/rpc-schemas";
import { voteClickSource } from "./vote-source";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const sources: ArenaVoteSource[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function recordSource(event: GestureResponderEvent) {
  sources.push(await voteClickSource(event));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

it("keeps browser automation unverified and identifies scripted votes", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <Pressable accessibilityRole="button" onPress={recordSource}>
        <Text>Vote</Text>
      </Pressable>,
    );
  });
  const vote = page.getByRole("button", { name: "Vote" });
  await vote.click();
  expect(sources).toEqual(["unverified"]);

  await userEvent.keyboard("{Enter}");
  expect(sources).toEqual(["unverified", "unverified"]);

  await userEvent.keyboard(" ");
  expect(sources).toEqual(["unverified", "unverified", "unverified"]);

  vote.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await expect.poll(() => sources).toEqual(["unverified", "unverified", "unverified", "synthetic"]);
});
