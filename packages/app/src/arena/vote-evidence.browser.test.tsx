import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text, type GestureResponderEvent } from "react-native";
import type { ArenaVoteEvidence } from "@getpaseo/protocol/arena/rpc-schemas";
import { voteEvidence } from "./vote-evidence";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const evidence: ArenaVoteEvidence[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function recordEvidence(event: GestureResponderEvent) {
  evidence.push(await voteEvidence(event));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

it("records browser automation without an OS monitor and identifies scripted votes", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <Pressable accessibilityRole="button" onPress={recordEvidence}>
        <Text>Vote</Text>
      </Pressable>,
    );
  });
  const vote = page.getByRole("button", { name: "Vote" });
  const pointer = { activation: "trusted", input: "pointer", os: { status: "no-monitor" } };
  const keyboard = { activation: "trusted", input: "keyboard", os: { status: "no-monitor" } };
  await vote.click();
  expect(evidence).toEqual([pointer]);

  await userEvent.keyboard("{Enter}");
  expect(evidence).toEqual([pointer, keyboard]);

  await userEvent.keyboard(" ");
  expect(evidence).toEqual([pointer, keyboard, keyboard]);

  vote.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await expect
    .poll(() => evidence)
    .toEqual([pointer, keyboard, keyboard, { activation: "script" }]);
});
