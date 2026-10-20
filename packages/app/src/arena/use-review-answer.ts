import { useCallback, useEffect, useState } from "react";
import type { ArenaReviewAnswer, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { heldResolveStep, type HeldResolvePrompt } from "./review";

/**
 * Answers a parked review. "Let an agent resolve" adds a prompt for the agent, which waits for the
 * apply the answers start: the agent must not edit the checkout while Arena is still writing it.
 */
export function useReviewAnswer(input: {
  snapshot: ArenaSnapshot | undefined;
  answerReview: (answers: readonly ArenaReviewAnswer[]) => Promise<ArenaSnapshot["turn"] | null>;
  askAgent: (prompt: string) => void;
}) {
  const { answerReview, askAgent } = input;
  const turn = input.snapshot?.turn;
  const [held, setHeld] = useState<HeldResolvePrompt | null>(null);

  // The turn comes from the daemon's stream; the apply's outcome arrives there, not in the answer.
  useEffect(() => {
    if (!held) return;
    const step = heldResolveStep(held, turn);
    if (step === "wait") return;
    setHeld(null);
    if (step === "send") askAgent(held.prompt);
  }, [askAgent, held, turn]);

  return useCallback(
    async (answers: ArenaReviewAnswer[], followUp?: string) => {
      const claimed = await answerReview(answers);
      if (!claimed || !followUp) return;
      setHeld({ turnId: claimed.id, claimedAt: claimed.updatedAt, prompt: followUp });
    },
    [answerReview],
  );
}
