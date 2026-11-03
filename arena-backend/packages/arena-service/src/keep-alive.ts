/**
 * Anthropic keeps a cached prompt for five minutes after the last request that read it. A contestant
 * that waits longer between two calls of one turn (a long tool run, a permission prompt, a subagent)
 * pays to write its whole conversation again. While it waits, the engine re-sends its last request
 * with this header (`opencode/src/arena/keep-alive.ts`), and the proxy forwards it with a one-token
 * answer, which reads the cached prompt and so keeps it.
 *
 * The engine cannot tell which side is Claude, so it pings every waiting side. Only `anthropic/`
 * slugs cache by request; every other ping gets the same answer without reaching OpenRouter.
 */
export const KEEP_ALIVE_HEADER = "x-arena-keep-alive"

export function keepsCacheWarm(slug: string) {
  return slug.startsWith("anthropic/")
}

/** One answer for every ping, forwarded or not, so the engine learns nothing about the model. */
export function keepAliveAnswer() {
  return new Response(null, { status: 204, headers: { [KEEP_ALIVE_HEADER]: "1" } })
}
