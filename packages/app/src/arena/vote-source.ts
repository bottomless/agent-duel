import {
  ArenaVoteInputSchema,
  ArenaVoteEvidenceSchema,
  ArenaVoteTargetSchema,
  type ArenaVoteEvidence,
  type ArenaVoteInputRequest,
  type ArenaVoteTarget,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { getDesktopHost } from "@/desktop/host";

interface VoteSourceInput {
  event: unknown;
  target: ArenaVoteTarget;
  nativeInput: ((input: ArenaVoteInputRequest) => Promise<ArenaVoteEvidence>) | null;
}

export async function classifyVoteSource({
  event,
  target,
  nativeInput,
}: VoteSourceInput): Promise<ArenaVoteEvidence> {
  if (!ArenaVoteTargetSchema.safeParse(target).success) return { source: "unknown" };
  if (typeof event !== "object" || event === null) return { source: "unknown" };
  // React Native Web forwards keyboard activation as a DOM event, clicks as a React event.
  const nativeEvent = "nativeEvent" in event ? event.nativeEvent : event;
  if (typeof nativeEvent !== "object" || nativeEvent === null) return { source: "unknown" };
  if (!("isTrusted" in nativeEvent)) return { source: "unknown" };
  if (nativeEvent.isTrusted === false) return { source: "synthetic" };
  if (nativeEvent.isTrusted !== true) return { source: "unknown" };
  if (!nativeInput) return { source: "unverified" };

  let candidate: unknown;
  if ("key" in nativeEvent) {
    candidate = { kind: "keyboard", key: nativeEvent.key };
  } else if ("screenX" in nativeEvent && "screenY" in nativeEvent) {
    candidate = { kind: "pointer", screenX: nativeEvent.screenX, screenY: nativeEvent.screenY };
  }
  const input = ArenaVoteInputSchema.safeParse(candidate);
  if (!input.success) return { source: "unknown" };
  try {
    return ArenaVoteEvidenceSchema.parse(await nativeInput({ target, input: input.data }));
  } catch {
    // Input telemetry must never prevent a vote when the native bridge is unavailable.
    return { source: "unknown" };
  }
}

export function voteClickSource(
  event: unknown,
  target: ArenaVoteTarget,
): Promise<ArenaVoteEvidence> {
  const nativeInput = getDesktopHost()?.voteInput?.source ?? null;
  return classifyVoteSource({ event, target, nativeInput });
}
