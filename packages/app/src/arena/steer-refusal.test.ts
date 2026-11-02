import { expect, test } from "vitest";
import { arenaSteerRefusalOr } from "./steer-refusal";

function rpcError(code: string) {
  return Object.assign(
    new Error(
      `Agent B is finishing its turn. Send your message again. requestType=arena.turn.reply.request code=${code}`,
    ),
    { code },
  );
}

test("a steer refused at the end of a turn reads without the request details", () => {
  expect(arenaSteerRefusalOr(rpcError("arena_side_closing"), "b")).toMatchObject({
    message: "Agent B is finishing its turn. Send your message again.",
  });
  expect(arenaSteerRefusalOr(rpcError("arena_side_closing"), "both")).toMatchObject({
    message: "An agent is finishing its turn. Send your message again.",
  });
});

test("any other failure is left as it is", () => {
  const failure = rpcError("handler_error");
  expect(arenaSteerRefusalOr(failure, "a")).toBe(failure);
});
