import {
  ArenaVoteInputSchema,
  ArenaVoteSourceSchema,
  type ArenaVoteInput,
  type ArenaVoteSource,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { getDesktopHost } from "@/desktop/host";

interface VoteSourceInput {
  event: unknown;
  nativeInput: ((input: ArenaVoteInput) => Promise<ArenaVoteSource>) | null;
}

export async function classifyVoteSource({
  event,
  nativeInput,
}: VoteSourceInput): Promise<ArenaVoteSource> {
  if (typeof event !== "object" || event === null) return "unknown";
  // React Native Web forwards keyboard activation as a DOM event, clicks as a React event.
  const nativeEvent = "nativeEvent" in event ? event.nativeEvent : event;
  if (typeof nativeEvent !== "object" || nativeEvent === null) return "unknown";
  if (!("isTrusted" in nativeEvent)) return "unknown";
  if (nativeEvent.isTrusted === false) return "synthetic";
  if (nativeEvent.isTrusted !== true) return "unknown";
  if (!nativeInput) return "unverified";

  let candidate: unknown;
  if ("key" in nativeEvent) {
    candidate = { kind: "keyboard", key: nativeEvent.key };
  } else if ("screenX" in nativeEvent && "screenY" in nativeEvent) {
    candidate = { kind: "pointer", screenX: nativeEvent.screenX, screenY: nativeEvent.screenY };
  }
  const input = ArenaVoteInputSchema.safeParse(candidate);
  if (!input.success) return "unverified";
  try {
    return ArenaVoteSourceSchema.parse(await nativeInput(input.data));
  } catch {
    // Input telemetry must never prevent a vote when the native bridge is unavailable.
    return "unknown";
  }
}

export function voteClickSource(event: unknown): Promise<ArenaVoteSource> {
  const nativeInput = getDesktopHost()?.voteInput?.source ?? null;
  return classifyVoteSource({ event, nativeInput });
}
