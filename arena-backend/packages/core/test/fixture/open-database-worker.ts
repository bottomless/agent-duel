import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"

const filename = process.argv[2]
if (!filename) throw new Error("Missing database path")

await Effect.runPromise(
  Effect.scoped(Layer.build(Database.layer({ path: filename }))).pipe(
    Effect.provideService(Global.Service, Global.make({ data: path.dirname(filename) })),
  ),
)
