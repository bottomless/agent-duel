import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session/session"
import { Todo } from "../../src/session/todo"
import { MessageID } from "../../src/session/schema"
import { Parameters, TodoWriteTool } from "../../src/tool/todo"
import { fromSchema } from "../../src/tool/json-schema"
import { Truncate } from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Todo.node, Truncate.node, Agent.node])),
)

describe("todowrite", () => {
  test("constrains new tool calls to known status and priority values", () => {
    expect(fromSchema(Parameters).properties?.todos).toMatchObject({
      items: {
        properties: {
          status: { enum: ["pending", "in_progress", "completed", "cancelled"] },
          priority: { enum: ["high", "medium", "low"] },
        },
      },
    })
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(decode({ todos: [{ content: "Task", status: "pending", priority: "high" }] })).toEqual({
      todos: [{ content: "Task", status: "pending", priority: "high" }],
    })
    expect(() => decode({ todos: [{ content: "Task", status: "done", priority: "high" }] })).toThrow()
    expect(() => decode({ todos: [{ content: "Task", status: "pending", priority: "urgent" }] })).toThrow()
    expect(() => decode({ todos: [{ content: "Task", status: "high", priority: "completed" }] })).toThrow()
  })

  it.instance("persists valid task lists", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const todo = yield* Todo.Service
      const chat = yield* session.create({ title: "Todo normalization" })
      const info = yield* TodoWriteTool
      const tool = yield* info.init()
      const ctx = {
        sessionID: chat.id,
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const tasks = [
        { content: "Valid", status: "pending", priority: "high" },
        { content: "Finished", status: "completed", priority: "medium" },
        { content: "Abandoned", status: "cancelled", priority: "low" },
      ]
      const result = yield* tool.execute({ todos: tasks } as Schema.Schema.Type<typeof Parameters>, ctx)
      expect(yield* todo.get(chat.id)).toEqual(tasks)
      expect(result.metadata.todos).toEqual(tasks)
      expect(JSON.parse(result.output)).toEqual(tasks)
      expect(result.title).toBe("2 todos")
      const cleared = yield* tool.execute({ todos: [] }, ctx)
      expect(yield* todo.get(chat.id)).toEqual([])
      expect(cleared.metadata.todos).toEqual([])
      expect(JSON.parse(cleared.output)).toEqual([])
    }),
  )
})
