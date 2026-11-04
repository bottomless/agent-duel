import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Queue, Scope, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import path from "node:path"
import { Shell } from "@opencode/core/shell"
import { Workspace } from "@opencode/core/workspace"
import { Global } from "@opencode/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { location, tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

it.live("eviction makes progress past an already-removed shell", () =>
  Effect.gen(function* () {
    const completions = yield* Queue.unbounded<Effect.Effect<void>>()
    const environment = Layer.effect(
      Environment.Service,
      Effect.gen(function* () {
        const host = yield* Environment.Service
        const scope = yield* Scope.Scope
        return Environment.Service.of({
          ...host,
          spawner: ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const exited = yield* Deferred.make<ExitCode>()
              const observer = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
              yield* Queue.offer(
                completions,
                Effect.gen(function* () {
                  yield* Deferred.succeed(exited, ExitCode(0))
                  // Shell.wait resolves before retention runs; join the whole exit handler instead.
                  const fiber = yield* Deferred.await(observer)
                  yield* Fiber.join(fiber).pipe(Effect.orDie)
                }),
              )
              const output = Stream.succeed(Buffer.from("hello"))
              return makeHandle({
                pid: ProcessId(1),
                exitCode: Effect.withFiber((fiber) =>
                  Scope.addFinalizer(scope, Fiber.interrupt(fiber)).pipe(
                    Effect.andThen(Deferred.succeed(observer, fiber)),
                    Effect.andThen(Deferred.await(exited)),
                  ),
                ),
                isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
                kill: () => Deferred.succeed(exited, ExitCode(0)).pipe(Effect.asVoid),
                stdin: Sink.drain,
                stdout: output,
                stderr: Stream.empty,
                all: output,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              })
            }),
          ),
        })
      }),
    ).pipe(Layer.provide(hostEnvironmentLayer))

    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const removed = yield* shell.create({ shell: "sh", command: "removed", timeout: 0 })
      const finishRemoved = yield* Queue.take(completions)
      yield* shell.remove(removed.id)
      expect((yield* shell.result(removed)).capture).toBeUndefined()
      yield* finishRemoved

      const complete = Effect.gen(function* () {
        const info = yield* shell.create({ shell: "sh", command: "hello", timeout: 0 })
        const finish = yield* Queue.take(completions)
        yield* finish
        return info
      })
      const oldest = yield* complete
      // Exceed the 25-entry retention cap with the removed ID at the head of exitOrder.
      yield* Effect.forEach(Array.from({ length: 25 }), () => complete, { discard: true })
      expect(yield* shell.get(oldest.id).pipe(Effect.flip)).toBeInstanceOf(Shell.NotFoundError)

      const survivor = yield* complete
      expect(yield* shell.result(survivor)).toMatchObject({
        info: { status: "exited", exit: 0 },
        capture: { output: "hello", truncated: false },
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Shell.node, [
          Location.node.replace(tempLocationLayer),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(environment),
        ]),
      ),
    )
  }),
)

it.live("does not inherit host process.env when creating a shell in a workspace-backed location", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    let capturedEnv: Record<string, string | undefined> | undefined
    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const info = yield* shell.create({ shell: "/bin/sh", command: "printf ok", timeout: 0 }, (invocation) =>
        Effect.sync(() => {
          capturedEnv = { ...invocation.env }
        }),
      )
      expect(yield* shell.result(info)).toMatchObject({
        info: { status: "exited" },
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Shell.node, [
          Location.node.replace(
            Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  Location.Ref.make({
                    directory: AbsolutePath.make(tmp.path),
                    workspaceID: Workspace.ID.make("wrk_workspace"),
                  }),
                ),
              ),
            ),
          ),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(hostEnvironmentLayer),
        ]),
      ),
    )

    expect(process.env.PATH).toBeDefined()
    expect(capturedEnv).toEqual({
      TERM: "xterm-256color",
      OPENCODE_TERMINAL: "1",
    })
  }),
)

it.live("a shell hook isolates output, keeps it readable after exit, and removes it explicitly", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const hooks = yield* PluginHooks.Service
      const global = yield* Global.Service
      const active = yield* Location.Service
      const outputs = path.join(tmp.path, "contestant-temp")
      const registration = yield* hooks.register("shell", "create.before", (event) =>
        Effect.sync(() => {
          event.outputDirectory = outputs
        }),
      )
      const info = yield* shell.create({
        shell: "/bin/sh",
        command: "printf retained-output",
        metadata: { sessionID: "side" },
      })
      expect(path.dirname(info.file)).toBe(outputs)
      expect(yield* shell.result(info)).toMatchObject({
        info: { status: "exited", file: info.file },
        capture: { output: "retained-output", truncated: false },
      })
      expect(yield* Effect.promise(() => Bun.file(info.file).text())).toBe("retained-output")
      expect(yield* shell.output(info.id)).toMatchObject({ output: "retained-output" })
      yield* registration.dispose
      const ordinary = yield* shell.create({ shell: "/bin/sh", command: "printf ordinary" })
      expect(path.dirname(ordinary.file)).toBe(path.join(global.data, Shell.DIRECTORY, active.project.id))
      yield* shell.result(ordinary)
      expect(yield* Effect.promise(() => Bun.file(info.file).text())).toBe("retained-output")
      yield* shell.remove(info.id)
      expect(yield* Effect.promise(() => Bun.file(info.file).exists())).toBe(false)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Shell.node, PluginHooks.node, Global.node, Location.node]), [
          Location.node.replace(tempLocationLayer),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(hostEnvironmentLayer),
        ]),
      ),
    )
  }),
)
