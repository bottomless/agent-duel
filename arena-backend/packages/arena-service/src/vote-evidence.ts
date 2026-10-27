import { z } from "zod"

/** Bump when a rule changes what stored evidence classifies as, so stored votes can be recomputed. */
export const voteSourceRules = 1

export const VoteSource = ["synthetic", "unknown", "api", "native", "injected", "unverified"] as const
export type VoteSource = (typeof VoteSource)[number]

const macosEvent = z.object({
  platform: z.literal("darwin"),
  /** Whether the event names the process that posted it. Hardware input names none. */
  sourceProcess: z.enum(["none", "present", "unavailable"]),
})

const windowsEvent = z.object({
  platform: z.literal("win32"),
  origin: z.enum(["hardware", "injected", "system", "unavailable"]),
  device: z.enum(["mouse", "touchpad", "touch", "pen", "keyboard", "other", "unavailable"]),
})

const osActivationSchema = z.discriminatedUnion("status", [
  /** The app has no desktop bridge: the browser QA harness. */
  z.object({ status: z.literal("no-monitor") }),
  /** The desktop has no working input monitor: Linux, a monitor that failed to load, a closed window. */
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("unmatched") }),
  z.object({
    status: z.literal("matched"),
    elapsedMs: z.number().int().nonnegative(),
    /** The larger axis offset between the click and the OS event, in screen pixels; null for keys. */
    distance: z.number().nonnegative().nullable(),
    event: z.discriminatedUnion("platform", [macosEvent, windowsEvent]),
  }),
])

/** What the desktop observed about the click or key press that cast a vote. */
export const VoteEvidenceSchema = z.discriminatedUnion("activation", [
  /** No event, no trust flag, or an input that cannot cast a vote. */
  z.object({ activation: z.literal("unrecognized") }),
  /** The browser reports the event as dispatched by a script. */
  z.object({ activation: z.literal("script") }),
  z.object({
    activation: z.literal("trusted"),
    input: z.enum(["pointer", "keyboard"]),
    os: osActivationSchema,
  }),
])
export type VoteEvidence = z.infer<typeof VoteEvidenceSchema>

type OsActivation = z.infer<typeof osActivationSchema>
type MatchedEvent = Extract<OsActivation, { status: "matched" }>["event"]

/**
 * Whether a vote arrived signed by the vote frame the control plane serves for that battle. A
 * deployment without a frame has no verifier and records nothing.
 */
export const VoteProof = ["verified", "invalid", "absent"] as const
export type VoteProof = (typeof VoteProof)[number]

export interface VoteProofCheck {
  readonly callerID: string
  readonly kind: "battle" | "single"
  readonly scopeID: string
  readonly decision: string
  /** The evidence exactly as the vote carried it, which the frame signed. */
  readonly evidence: unknown
  readonly proof: unknown
}

export type VerifyVoteProof = (check: VoteProofCheck) => Promise<Exclude<VoteProof, "absent">>

export interface ClassifiedVote {
  readonly voteSource: VoteSource
  readonly voteSourceRules: number
  /** Absent when the vote carried no evidence or evidence that did not parse. */
  readonly voteEvidence?: VoteEvidence
}

const pointerDevices: ReadonlySet<string> = new Set(["mouse", "touchpad", "touch", "pen"])

function matchedSource(input: "pointer" | "keyboard", event: MatchedEvent): VoteSource {
  if (event.platform === "darwin") {
    if (event.sourceProcess === "none") return "native"
    if (event.sourceProcess === "present") return "injected"
    return "unknown"
  }
  const expectedDevice = input === "pointer" ? pointerDevices.has(event.device) : event.device === "keyboard"
  if (!expectedDevice) return "unknown"
  // Windows also reports UIAccess SendInput as hardware. That is an OS evidence limit.
  if (event.origin === "hardware") return "native"
  if (event.origin === "injected" || event.origin === "system") return "injected"
  return "unknown"
}

function evidenceSource(evidence: VoteEvidence): VoteSource {
  if (evidence.activation === "unrecognized") return "unknown"
  if (evidence.activation === "script") return "synthetic"
  const { os } = evidence
  if (os.status === "no-monitor" || os.status === "unmatched") return "unverified"
  if (os.status === "unavailable") return "unknown"
  return matchedSource(evidence.input, os.event)
}

/** Null evidence marks a vote from an API caller; evidence that does not parse proves nothing. */
export function classifyVote(evidence: unknown): ClassifiedVote {
  if (evidence === null) return { voteSource: "api", voteSourceRules }
  const parsed = VoteEvidenceSchema.safeParse(evidence)
  if (!parsed.success) return { voteSource: "unknown", voteSourceRules }
  return { voteSource: evidenceSource(parsed.data), voteSourceRules, voteEvidence: parsed.data }
}

export * as ArenaVoteEvidence from "./vote-evidence"
