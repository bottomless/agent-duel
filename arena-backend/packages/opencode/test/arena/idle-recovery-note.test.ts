import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema"
import { Provider } from "@opencode/schema/provider"
import { SessionMessage } from "@opencode/core/session/message"
import { ArenaResponseRecovery } from "@/arena/response-recovery"
import { idleRecoveryNote } from "@/arena/engine-runtime/idle"

const created = 1
// Only the content's shape matters here, so the rows skip schema construction.
const assistant = (content: readonly unknown[]) =>
  ({
    id: SessionMessage.ID.make("msg_idle_cut"),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: Model.Ref.make({ id: Model.ID.make("contestant"), providerID: Provider.ID.make("arena") }),
    content,
    error: { type: "provider.transport", message: "SSE read timed out" },
    time: { created },
  }) as unknown as SessionMessage.Info
const tool = (id: string, ran: boolean, executed?: boolean) => ({
  type: "tool",
  id,
  name: "write",
  input: {},
  ...(executed ? { executed } : {}),
  state: ran ? { status: "completed", input: {}, output: "ok", metadata: {} } : { status: "streaming", input: "{" },
  time: { created, ...(ran ? { ran: created } : {}) },
})

// Core replays a cut answer only up to its last local call that ran (to-llm-message.ts).
test("an idle stall continues only from a local call that ran; anything else starts again", () => {
  expect(idleRecoveryNote(assistant([tool("call_ran", true), tool("call_cut", false)]))).toBe(
    ArenaResponseRecovery.IDLE_CONTINUE,
  )
  expect(idleRecoveryNote(assistant([{ type: "text", text: "A partial answer" }]))).toBe(
    ArenaResponseRecovery.IDLE_RESTART,
  )
  expect(idleRecoveryNote(assistant([tool("call_cut", false)]))).toBe(ArenaResponseRecovery.IDLE_RESTART)
  expect(idleRecoveryNote(assistant([tool("hosted", true, true)]))).toBe(ArenaResponseRecovery.IDLE_RESTART)
  expect(idleRecoveryNote(undefined)).toBe(ArenaResponseRecovery.IDLE_RESTART)
})
