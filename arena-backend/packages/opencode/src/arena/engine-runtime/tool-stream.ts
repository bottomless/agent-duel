import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"

type HeldCall = {
  readonly end: LanguageModelV3StreamPart
  call?: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>
  late: string
}

/**
 * `@openrouter/ai-sdk-provider` ends a tool call the moment its arguments parse as JSON, and sends
 * a `tool-input-delta` for every later chunk of that call. Qwen 3.8 Max sends an empty chunk after
 * the closing brace, and Core treats a delta after the end as a defect that kills the run
 * (`publish-llm-event.ts`, anomalyco/opencode#35336). Core also starts the tool at `tool-call`, so a
 * model that streams `{}` and then the real arguments would run the tool with `{}`.
 *
 * Hold each ended call until the model finishes, as Core's native routes do
 * (`ai/src/protocols/utils/tool-stream.ts`), and call it with everything the model sent. Blank late
 * text changes nothing. Any other late text fails Core's JSON parse, so the tool does not run and the
 * model gets the error that asks it to send the call again.
 *
 * A stream cut before `finish` releases no executable call. Arena's proxy turns a close without
 * a finish into a provider error. Core settles held calls with `provider.internal`,
 * `provider.transport`, or `aborted`; complete arguments stay in the failed history.
 */
function holdEndedToolCalls() {
  const held = new Map<string, HeldCall>()
  return new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
    transform(part, controller) {
      switch (part.type) {
        case "tool-input-end":
          held.set(part.id, { end: part, late: "" })
          return
        case "tool-input-delta": {
          const call = held.get(part.id)
          if (call) {
            if (part.delta.length === 0) return
            call.late += part.delta
          }
          controller.enqueue(part)
          return
        }
        case "tool-call": {
          const call = held.get(part.toolCallId)
          if (call) call.call = part
          else controller.enqueue(part)
          return
        }
        case "finish":
          for (const { end, call, late } of held.values()) {
            controller.enqueue(end)
            if (call) controller.enqueue({ ...call, input: call.input + late })
          }
          held.clear()
          controller.enqueue(part)
          return
        default:
          controller.enqueue(part)
      }
    },
  })
}

/** The same language model, with each tool call delivered once its arguments can no longer change. */
export function withHeldToolCalls(language: LanguageModelV3): LanguageModelV3 {
  return {
    specificationVersion: language.specificationVersion,
    provider: language.provider,
    modelId: language.modelId,
    supportedUrls: language.supportedUrls,
    doGenerate: (options) => language.doGenerate(options),
    doStream: async (options) => {
      const result = await language.doStream(options)
      return { ...result, stream: result.stream.pipeThrough(holdEndedToolCalls()) }
    },
  }
}
