import { ProviderError } from "@/provider/error"

type Part = {
  type: string
  toolCallId?: string
  preliminary?: boolean
  providerExecuted?: boolean
}

// Keep the deadline on model activity, not on local tools or permission waits.
export function timeoutModelIdle<T extends Part>(
  stream: AsyncIterable<T>,
  abort: AbortController,
  ms: number,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = watchModelIdle(stream, abort, ms)
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
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]()
  const pendingTools = new Set<string>()
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
                  reject(error)
                  abort.abort(error)
                }, ms)
              }),
            ]))
        if (part.done) return
        const event = part.value
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
