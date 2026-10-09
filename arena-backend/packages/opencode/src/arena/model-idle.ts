import { ProviderError } from "@/provider/error"

type Part = {
  type: string
  toolCallId?: string
  preliminary?: boolean
  providerExecuted?: boolean
}

/** What the model call produced before its deadline passed. Part types only, never content. */
export type ModelIdleActivity = {
  readonly parts: number
  readonly sinceStartMs: number
  /** The latest runs of one part type, oldest first, such as `reasoning-delta*340 raw*2`. */
  readonly recentParts: string
}

const RECENT_PART_RUNS = 8

// Keep the deadline on model activity, not on local tools or permission waits.
export function timeoutModelIdle<T extends Part>(
  stream: AsyncIterable<T>,
  abort: AbortController,
  ms: number,
  onIdle?: (activity: ModelIdleActivity) => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = watchModelIdle(stream, abort, ms, onIdle)
      return {
        next: () => iterator.next(),
        return: () => {
          // An async generator queues return behind its pending next. Abort the tool first,
          // before Effect waits for that return during stream finalization.
          abort.abort()
          return iterator.return(undefined)
        },
      }
    },
  }
}

async function* watchModelIdle<T extends Part>(
  stream: AsyncIterable<T>,
  abort: AbortController,
  ms: number,
  onIdle?: (activity: ModelIdleActivity) => void,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]()
  const pendingTools = new Set<string>()
  const startedAt = Date.now()
  const recent: { type: string; count: number }[] = []
  let parts = 0
  try {
    while (true) {
      const next = iterator.next()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const part = await (pendingTools.size
          ? next
          : Promise.race([
              next,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  if (abort.signal.aborted) {
                    reject(abort.signal.reason)
                    return
                  }
                  const error = new ProviderError.ResponseStreamError(`Arena model response was idle for ${ms}ms`)
                  onIdle?.({
                    parts,
                    sinceStartMs: Date.now() - startedAt,
                    recentParts: recent.map((run) => `${run.type}*${run.count}`).join(" "),
                  })
                  reject(error)
                  abort.abort(error)
                }, ms)
              }),
            ]))
        if (part.done) return
        const event = part.value
        parts++
        const last = recent.at(-1)
        if (last?.type === event.type) last.count++
        else {
          recent.push({ type: event.type, count: 1 })
          if (recent.length > RECENT_PART_RUNS) recent.shift()
        }
        if (event.type === "tool-call" && !event.providerExecuted && event.toolCallId) {
          pendingTools.add(event.toolCallId)
        }
        if (
          (event.type === "tool-result" && !event.preliminary) ||
          event.type === "tool-error" ||
          event.type === "tool-output-denied"
        ) {
          if (event.toolCallId) pendingTools.delete(event.toolCallId)
        }
        yield event
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
  } finally {
    if (abort.signal.aborted) void Promise.resolve(iterator.return?.()).catch(() => {})
  }
}
