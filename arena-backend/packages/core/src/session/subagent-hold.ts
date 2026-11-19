export * as SubagentHold from "./subagent-hold.js"

import { Effect } from "effect"
import type { SessionSchema } from "./schema.js"

// Agent Duel: whoever stops a run decides what runs next, so a child's report must not wake its
// parent after a stop. Held parents still receive the report in their inbox, and the next run that
// the parent's owner starts delivers it.
const held = new Set<SessionSchema.ID>()

/** Stops child reports from starting a run of this parent. */
export const hold = (parentSessionID: SessionSchema.ID) => Effect.sync(() => void held.add(parentSessionID))

/** Lets child reports start runs of this parent again. */
export const release = (parentSessionID: SessionSchema.ID) => Effect.sync(() => void held.delete(parentSessionID))

export const isHeld = (parentSessionID: SessionSchema.ID) => held.has(parentSessionID)
