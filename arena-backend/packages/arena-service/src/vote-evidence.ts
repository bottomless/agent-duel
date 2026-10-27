import { z } from "zod"

export const VoteSource = ["synthetic", "unknown", "api", "native", "injected", "unverified"] as const
export type VoteSource = (typeof VoteSource)[number]

const macosEvent = z.object({
  platform: z.literal("darwin"),
  /** Whether the event names the process that posted it. */
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

/** What a deployment's classifier decided about a vote. */
export interface ClassifiedVote {
  readonly voteSource: VoteSource
  /** The version of the rules that decided it, so stored evidence can be classified again. */
  readonly voteSourceRules: number
}

/**
 * Decides `voteSource` from the evidence exactly as the vote carried it, null when it carried none.
 * The rules belong to the deployment that runs them; a deployment without them records no source.
 */
export type ClassifyVote = (evidence: unknown) => ClassifiedVote

export * as ArenaVoteEvidence from "./vote-evidence"
