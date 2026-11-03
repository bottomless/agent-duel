import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { requestRef } from "@opencode/server/location"
import { CurrentDirectory } from "@/project/instance-context"

// Use the native V2 decoder so Arena and /api agree on the same filesystem path.
export const currentDirectoryMiddleware = HttpRouter.middleware()((effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const pathname = new URL(request.url, "http://localhost").pathname
    if (!pathname.startsWith("/arena/") || !request.headers["x-opencode-directory"]) return yield* effect
    return yield* effect.pipe(Effect.provideService(CurrentDirectory, requestRef(request)))
  }),
).layer
