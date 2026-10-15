import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

export type SingleAgentModelSize = NonNullable<ArenaSnapshot["singleAgent"]>["modelSize"];

export const SINGLE_AGENT_MODELS = {
  medium: { model: "arena/medium", thinking: "xhigh", label: "GPT Luna 5.6 Xhigh" },
  frontier: {
    model: "arena/contestant",
    thinking: "high",
    label: "Model hidden · Rating required",
  },
} as const;

export function singleAgentRatingRequired(singleAgent: ArenaSnapshot["singleAgent"]): boolean {
  return singleAgent?.ratingRequired === true && singleAgent.vote === undefined;
}

export function singleAgentControlsLocked(input: {
  singleAgent: ArenaSnapshot["singleAgent"];
  modelSize: SingleAgentModelSize;
  running: boolean;
}): boolean {
  if (singleAgentRatingRequired(input.singleAgent)) return true;
  return input.running && input.modelSize === "frontier";
}
