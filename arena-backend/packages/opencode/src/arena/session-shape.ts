import { Schema } from "effect"
import { SessionV1 as NativeV1 } from "@opencode/schema/v1/session"

export * from "@opencode/schema/v1/session"

// Arena keeps this transcript projection across engine upgrades. Native V2
// messages remain canonical and retain their provider replay data separately.
export const WithParts = Schema.Struct({ info: NativeV1.Info, parts: Schema.Array(NativeV1.Part) })
export type WithParts = typeof WithParts.Type

export * as SessionV1 from "./session-shape"
