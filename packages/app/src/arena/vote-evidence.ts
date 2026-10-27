import {
  ArenaOsActivationSchema,
  ArenaVoteInputSchema,
  type ArenaOsActivation,
  type ArenaVoteEvidence,
  type ArenaVoteInput,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { getDesktopHost } from "@/desktop/host";

type ObserveOsInput = (input: ArenaVoteInput) => Promise<ArenaOsActivation>;

interface VoteEvidenceInput {
  event: unknown;
  observe: ObserveOsInput | null;
}

async function osActivation(
  input: ArenaVoteInput,
  observe: ObserveOsInput | null,
): Promise<ArenaOsActivation> {
  if (!observe) return { status: "no-monitor" };
  try {
    return ArenaOsActivationSchema.parse(await observe(input));
  } catch {
    // Input evidence must never prevent a vote when the native bridge is unavailable.
    return { status: "unavailable" };
  }
}

function desktopObserver(): ObserveOsInput | null {
  return getDesktopHost()?.voteInput?.observe ?? null;
}

/** Records what the browser and the OS saw. The reveal, not the app, decides what it means. */
export async function collectVoteEvidence({
  event,
  observe,
}: VoteEvidenceInput): Promise<ArenaVoteEvidence> {
  if (typeof event !== "object" || event === null) return { activation: "unrecognized" };
  // React Native Web forwards keyboard activation as a DOM event, clicks as a React event.
  const nativeEvent = "nativeEvent" in event ? event.nativeEvent : event;
  if (typeof nativeEvent !== "object" || nativeEvent === null)
    return { activation: "unrecognized" };
  if (!("isTrusted" in nativeEvent)) return { activation: "unrecognized" };
  if (nativeEvent.isTrusted === false) return { activation: "script" };
  if (nativeEvent.isTrusted !== true) return { activation: "unrecognized" };

  let candidate: unknown;
  if ("key" in nativeEvent) {
    candidate = { kind: "keyboard", key: nativeEvent.key };
  } else if ("screenX" in nativeEvent && "screenY" in nativeEvent) {
    candidate = { kind: "pointer", screenX: nativeEvent.screenX, screenY: nativeEvent.screenY };
  }
  const input = ArenaVoteInputSchema.safeParse(candidate);
  if (!input.success) return { activation: "unrecognized" };
  return {
    activation: "trusted",
    input: input.data.kind,
    os: await osActivation(input.data, observe),
  };
}

export function voteEvidence(event: unknown): Promise<ArenaVoteEvidence> {
  return collectVoteEvidence({ event, observe: desktopObserver() });
}

/** What the OS saw of an activation a vote frame reports; the frame builds the rest itself. */
export function observeOsActivation(input: ArenaVoteInput): Promise<ArenaOsActivation> {
  return osActivation(input, desktopObserver());
}
