import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"

const filename = process.argv[2]
if (!filename) throw new Error("Missing database path")

await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
