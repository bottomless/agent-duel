import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { ArenaRuntime } from "@/arena/runtime"
import { contestant as arenaContestant, medium as arenaMedium, withLimits } from "@/arena/model-profile"
import type { Assignment } from "@/arena/proxy"
import { ArenaResponseRecovery } from "@/arena/response-recovery"
import { ArenaRequestBudget } from "@/arena/request-budget"
import type { ModelMessage } from "ai"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
// Arena cannot use a provider tokenizer without exposing the contestant model. Reserve a bounded
// allowance for each media item and omit its encoded bytes from the text estimate instead.
const ARENA_MEDIA_TOKEN_ALLOWANCE = 4_000
// Compaction is an internal checkpoint, not a new user task or permission to stop after one step.
const ARENA_COMPACTION_CONTINUE =
  "Resume the original user task from the summary and retained context. " +
  "Carry out the remaining steps, including verification, until the task is complete. " +
  'Do not end with a plan or "next step" while actionable work remains. ' +
  "Ask the user only when a concrete blocker requires information or authorization you do not have. " +
  "If the task is already complete, report the result."
const COMPACTION_EXHAUSTED =
  "The conversation could not be summarized after three recovery attempts. Completed work has been preserved. Retry to continue."
const ARENA_COMPACTION_OUTPUT_MAX = 8_192
const ARENA_COMPACTION_INPUT_HEADROOM = 0.8
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function estimateArenaModelMessages(messages: ModelMessage[]) {
  let mediaCount = 0
  const stripMediaField = (value: unknown, field: "data" | "image", types: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    const record = value as Record<string, unknown>
    if (!types.includes(String(record.type)) || !(field in record)) return value
    mediaCount++
    return Object.fromEntries(Object.entries(record).filter(([key]) => key !== field))
  }

  const withoutMedia = messages.map((message) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part) =>
          stripMediaField(part, part.type === "image" ? "image" : "data", ["file", "image"]),
        ),
      }
    }
    if (message.role === "tool") {
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "tool-result" || part.output.type !== "content") return part
          return {
            ...part,
            output: {
              ...part.output,
              value: part.output.value.map((item) => stripMediaField(item, "data", ["media", "file-data"])),
            },
          }
        }),
      }
    }
    return message
  })

  return Token.estimate(JSON.stringify(withoutMedia)) + mediaCount * ARENA_MEDIA_TOKEN_ALLOWANCE
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
    /** The history the counts describe. Arena persists zeroed counts, so it estimates from this. */
    messages?: SessionV1.WithParts[]
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return ArenaRuntime.enabled() ? estimateArenaModelMessages(msgs) : Token.estimate(JSON.stringify(msgs))
    })

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
      messages?: SessionV1.WithParts[]
    }) {
      // Arena blinds the stored counts because each tokenizer counts the same text differently.
      // An estimate from the text is the same for every model, so it reveals nothing.
      const estimated =
        ArenaRuntime.enabled() && input.messages
          ? yield* estimate({ messages: input.messages, model: input.model })
          : undefined
      const cfg = yield* config.get()
      const arenaLimit = ArenaRequestBudget.inputLimit({
        cfg,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
      const arenaLimitReached = estimated !== undefined && estimated >= arenaLimit
      if (cfg.compaction?.auto !== false && arenaLimitReached) return true
      return overflow({
        cfg,
        tokens:
          estimated === undefined
            ? input.tokens
            : { total: estimated, input: estimated, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const arenaAssignment = (sessionID: SessionID): Effect.Effect<Assignment | undefined> =>
      Effect.gen(function* () {
        const direct = ArenaRuntime.registry.assignments.get(sessionID)
        if (direct) return direct
        const info = yield* session.get(sessionID).pipe(Effect.orDie)
        if (!info.parentID) return undefined
        const inherited = yield* arenaAssignment(info.parentID)
        if (!inherited) return undefined
        return ArenaRuntime.registry.assign(sessionID, inherited)
      })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const assignment = yield* arenaAssignment(input.sessionID)
      const compactionModel = assignment
        ? {
            providerID: ProviderV2.ID.make(ArenaRuntime.providerID),
            modelID: ModelV2.ID.make(assignment.modelSize === "medium" ? arenaMedium.id : arenaContestant.id),
            variant: assignment.modelSize === "medium" ? "xhigh" : "high",
          }
        : userMessage.model
      const selectedModel = assignment
        ? yield* provider.getModel(compactionModel.providerID, compactionModel.modelID).pipe(Effect.orDie)
        : agent.model
          ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
          : yield* provider.getModel(compactionModel.providerID, compactionModel.modelID).pipe(Effect.orDie)
      const model = withLimits(selectedModel, assignment?.limits)
      const compactionUser = assignment ? { ...userMessage, model: compactionModel } : userMessage
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      // A new Arena request has not been acted on yet. Summarize only its earlier history;
      // retain the original message IDs and parts so pasted text and attachments stay exact.
      const finished = MessageV2.latest(history).finished
      const pendingIndex =
        input.auto && !input.overflow && userMessage.model.providerID === ArenaRuntime.providerID && finished
          ? history.findIndex(
              (message) =>
                message.info.role === "user" &&
                message.info.id > finished.id &&
                message.parts.some((part) => part.type !== "compaction" && (part.type !== "text" || !part.synthetic)),
            )
          : -1
      const pendingUser = pendingIndex >= 0 ? MessageV2.latest(history.slice(pendingIndex)).user : undefined
      const compactable = pendingIndex >= 0 ? history.slice(0, pendingIndex) : history
      const prior = completedCompactions(compactable)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: compactable.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      if (pendingIndex >= 0) selected.tail_start_id ??= history[pendingIndex].info.id
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const ctx = yield* InstanceState.context
      const createAssistant = (passModel: Provider.Model, summary: boolean): SessionV1.Assistant => ({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: compactionUser.model.variant,
        summary,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: passModel.id,
        providerID: passModel.providerID,
        time: { created: Date.now() },
      })

      const summarize = Effect.fnUntraced(function* (summarizeInput: {
        model: Provider.Model
        messages: ModelMessage[]
        summary: boolean
        responseRecovery?: { attempt: number; reason: ArenaResponseRecovery.Reason }
      }) {
        const msg = createAssistant(summarizeInput.model, summarizeInput.summary)
        yield* session.updateMessage(msg)
        const processor = yield* processors.create({
          assistantMessage: msg,
          sessionID: input.sessionID,
          model: summarizeInput.model,
          ...(summarizeInput.responseRecovery ? { responseRecovery: summarizeInput.responseRecovery } : {}),
        })
        const result = yield* processor.process({
          user: compactionUser,
          agent,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          // Savings ceilings do not restrict a summary; the endpoint context still does.
          messages: summarizeInput.messages,
          model: summarizeInput.model,
        })
        return { processor, result }
      })
      // A finished summary replaces the history before it, so one that timed out, hit its output cap
      // or came back empty would leave the contestant with no memory of its task. Retry an Arena
      // summary within the recovery budget, then fail it visibly with the history intact.
      const unusable = Effect.fnUntraced(function* (message: SessionV1.Assistant) {
        const reason = ArenaResponseRecovery.reason(message.finish)
        if (reason) return reason
        const stored = yield* session
          .findMessage(input.sessionID, (item) => item.info.id === message.id)
          .pipe(Effect.orElseSucceed(() => Option.none<SessionV1.WithParts>()))
        return Option.isSome(stored) && summaryText(stored.value) ? undefined : ("empty" as const)
      })
      const summarizeWithRecovery = Effect.fnUntraced(function* (summarizeInput: {
        model: Provider.Model
        messages: ModelMessage[]
        summary: boolean
      }) {
        let { processor, result } = yield* summarize(summarizeInput)
        for (
          let attempt = 1;
          summarizeInput.model.providerID === ArenaRuntime.providerID &&
          result === "continue" &&
          !processor.message.error;
          attempt++
        ) {
          const failure = yield* unusable(processor.message)
          if (!failure) break
          yield* Effect.logWarning("arena compaction summary unusable", {
            "session.id": input.sessionID,
            messageID: processor.message.id,
            failure,
            attempt,
          })
          if (attempt > ArenaResponseRecovery.MAX_RECOVERIES) {
            processor.message.error = new SessionV1.APIError({
              message: COMPACTION_EXHAUSTED,
              isRetryable: true,
            }).toObject()
            yield* session.updateMessage(processor.message)
            yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: processor.message.error })
            return { processor, result: "stop" as const }
          }
          yield* session.removeMessage({ sessionID: input.sessionID, messageID: processor.message.id })
          ;({ processor, result } = yield* summarize({
            ...summarizeInput,
            responseRecovery: failure === "empty" ? undefined : { attempt, reason: failure },
          }))
        }
        return { processor, result }
      })

      let processor: SessionProcessor.Handle
      let result: SessionProcessor.Result
      const boundedArena =
        assignment !== undefined &&
        estimateArenaModelMessages([...modelMessages, { role: "user", content: nextPrompt }]) >
          usable({ cfg, model, outputTokenMax: flags.outputTokenMax })

      if (!boundedArena) {
        ;({ processor, result } = yield* summarizeWithRecovery({
          model,
          messages: [...modelMessages, { role: "user", content: [{ type: "text", text: nextPrompt }] }],
          summary: true,
        }))
      } else {
        const transcript = modelMessages.map((message) => JSON.stringify(message)).join("\n")
        const passModel = {
          ...model,
          limit: { ...model.limit, output: Math.min(model.limit.output, ARENA_COMPACTION_OUTPUT_MAX) },
        }
        const inputBudget = Math.floor(
          usable({ cfg, model: passModel, outputTokenMax: flags.outputTokenMax }) * ARENA_COMPACTION_INPUT_HEADROOM,
        )
        let offset = 0
        let rollingSummary = previousSummary
        let pass = 0
        let lastProcessor: SessionProcessor.Handle | undefined
        let lastResult: SessionProcessor.Result = "stop"

        while (offset < transcript.length || pass === 0) {
          const prompt = compacting.prompt
            ? `${compacting.prompt}\n\nPrevious summary:\n${rollingSummary ?? ""}`
            : buildPrompt({ previousSummary: rollingSummary, context: compacting.context })
          const promptSize = estimateArenaModelMessages([
            { role: "user", content: [{ type: "text", text: "" }] },
            { role: "user", content: [{ type: "text", text: prompt }] },
          ])
          let end = offset
          if (inputBudget > promptSize) {
            let low = offset + 1
            let high = transcript.length
            while (low <= high) {
              const middle = Math.floor((low + high) / 2)
              const candidate: ModelMessage[] = [
                { role: "user", content: [{ type: "text", text: transcript.slice(offset, middle) }] },
                { role: "user", content: [{ type: "text", text: prompt }] },
              ]
              if (estimateArenaModelMessages(candidate) <= inputBudget) {
                end = middle
                low = middle + 1
              } else high = middle - 1
            }
          }
          const emptyTranscript = transcript.length === 0 && pass === 0
          if (end <= offset && !emptyTranscript) {
            throw new SessionV1.ContextOverflowError({
              message: "Session history cannot fit within the assigned model context limit",
            })
          }

          const currentResult = yield* summarizeWithRecovery({
            model: passModel,
            messages: [
              { role: "user", content: [{ type: "text", text: transcript.slice(offset, end) }] },
              { role: "user", content: [{ type: "text", text: prompt }] },
            ],
            summary: false,
          })
          lastProcessor = currentResult.processor
          lastResult = currentResult.result
          if (lastResult !== "continue" || lastProcessor.message.error) break
          const saved = (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
            (message) => message.info.id === lastProcessor!.message.id,
          )
          rollingSummary = saved && saved.info.role === "assistant" ? summaryText(saved) : undefined
          offset = end
          pass++
          if (offset < transcript.length) {
            yield* session.removeMessage({ sessionID: input.sessionID, messageID: lastProcessor.message.id })
          }
        }

        if (!lastProcessor) {
          throw new SessionV1.ContextOverflowError({
            message: "Session history cannot fit within the assigned model context limit",
          })
        }
        processor = lastProcessor
        result = lastResult
        if (result === "continue" && !processor.message.error) {
          processor.message.summary = true
          yield* session.updateMessage(processor.message)
        }
      }

      if (result === "compact" || result === "compact-request") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
          if (assignment) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              metadata: { arena_compaction_replay: true },
              text: ARENA_COMPACTION_CONTINUE,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            // The request that hit the limit took its system text from the user message before the
            // compaction one. Carry it on, as a replay does, or the turn continues without it.
            const answered = input.messages.findLast(
              (message) => message.info.role === "user" && message.info.id < input.parentID,
            )
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: pendingUser?.agent ?? userMessage.agent,
              model: pendingUser?.model ?? userMessage.model,
              system: pendingUser?.system ?? (answered?.info.role === "user" ? answered.info.system : undefined),
              tools: pendingUser?.tools,
              format: pendingUser?.format
                ? pendingUser.format.type === "json_schema"
                  ? new SessionV1.OutputFormatJsonSchema(pendingUser.format)
                  : new SessionV1.OutputFormatText(pendingUser.format)
                : undefined,
            })
            const continuation = assignment
              ? ARENA_COMPACTION_CONTINUE
              : "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            const text =
              (pendingUser ? "Process the new user message and attachments retained above. " : "") +
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              continuation
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

export * as SessionCompaction from "./compaction"
