import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { requestRef } from "@opencode/server/location"
import { currentDirectoryMiddleware } from "../../src/arena/http-directory"
import { CurrentDirectory } from "../../src/project/instance-context"

for (const directory of ["/tmp/space café 日本 100% %20", "/tmp/space café 100% %20", "/tmp/space 100%20"]) {
  test(`Arena and native V2 resolve and return the same directory: ${directory}`, async () => {
    const probe = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const arena = yield* CurrentDirectory
      return yield* HttpServerResponse.json({ arena: arena.directory, native: requestRef(request).directory })
    })
    const web = HttpRouter.toWebHandler(
      HttpRouter.add("*", "/arena/probe", probe).pipe(Layer.provide(currentDirectoryMiddleware)),
      { disableLogger: true },
    )
    try {
      for (const method of ["GET", "POST"]) {
        const response = await web.handler(new Request("http://engine.test/arena/probe", {
          method,
          headers: { "x-opencode-directory": encodeURIComponent(directory) },
        }))
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ arena: directory, native: directory })
      }
    } finally {
      await web.dispose()
    }
  })
}
