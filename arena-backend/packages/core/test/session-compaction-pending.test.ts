import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionMessage } from "@opencode/schema/session-message"
import { RETAINED_INPUT, toLLMMessages } from "@opencode/core/session/runner/to-llm-message"

const model = { providerID: Provider.ID.make("arena"), id: Model.ID.make("contestant") }
const pending: SessionMessage.User = {
  type: "user",
  id: SessionMessage.ID.make("msg_new_input"),
  time: { created: DateTime.makeUnsafe(100) },
  text: "Use the attached image verbatim",
  files: [{ source: { type: "inline" }, mime: "image/png", data: "aGVsbG8=", name: "latest.png" }],
}
const checkpoint: SessionMessage.CompactionCompleted = {
  type: "compaction",
  id: SessionMessage.ID.make("msg_checkpoint"),
  time: { created: DateTime.makeUnsafe(200) },
  status: "completed",
  reason: "auto",
  summary: "Earlier history",
  recent: "Recent completed exchange",
}

test("pending input survives a checkpoint JSON round trip with attachments outside summary text", () => {
  const stored = {
    ...checkpoint,
    metadata: { [RETAINED_INPUT]: Schema.encodeSync(Schema.Array(SessionMessage.User))([pending]) },
  }
  const wire = JSON.stringify(Schema.encodeSync(SessionMessage.Info)(stored))
  const restored = Schema.decodeUnknownSync(SessionMessage.Info)(JSON.parse(wire))
  const messages = toLLMMessages([restored], model)
  expect(messages).toHaveLength(2)
  expect(messages[0].content).toMatchObject([{ type: "text", text: expect.stringContaining("Earlier history") }])
  expect(messages[0].metadata).toEqual({})
  expect(messages[1]).toEqual(toLLMMessages([pending], model)[0])
  expect(messages[1].content).toMatchObject([
    { type: "text", text: pending.text },
    { type: "media", filename: "latest.png" },
  ])
  expect(JSON.stringify(messages[0])).not.toContain("aGVsbG8=")
})

test("a checkpoint without retained input keeps the existing single-message replay", () => {
  const messages = toLLMMessages([checkpoint], model)
  expect(messages).toHaveLength(1)
  expect(messages[0].content).toMatchObject([
    { type: "text", text: expect.stringContaining("Recent completed exchange") },
  ])
})
