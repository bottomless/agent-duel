export function comparisonTimeline(
  messages: readonly unknown[],
  promptMessageID: string | undefined,
  hidden: ReadonlySet<string>,
) {
  if (!promptMessageID) return "[]"
  const timeline = messages.flatMap((value) => {
    if (!record(value) || !record(value.info) || !Array.isArray(value.parts)) return []
    if (typeof value.info.id !== "string" || value.info.id <= promptMessageID) return []
    const role = value.info.role
    if (role !== "user" && role !== "assistant") return []
    const content = value.parts.flatMap((part): ComparisonTimelineEvent[] => {
      if (!record(part) || typeof part.type !== "string") return []
      // Reasoning is deliberately excluded. It is not part of the visible timeline this prompt claims
      // to describe, it dwarfs the visible text by roughly 9:1, and a comparison model handed both
      // contestants' private deliberation will chase differences that exist only in their thinking
      // rather than in the code they produced.
      if (part.type === "text" && typeof part.text === "string") {
        return [{ type: "narrative", text: part.text }]
      }
      // A reply's attached image. The judge cannot see it, but should know the contestant could.
      if (role === "user" && part.type === "file" && typeof part.mime === "string" && part.mime.startsWith("image/")) {
        return [
          { type: "narrative", text: `[attached image ${typeof part.filename === "string" ? part.filename : ""}]` },
        ]
      }
      if (part.type !== "tool" || typeof part.tool !== "string" || !record(part.state)) return []
      if (typeof part.state.status !== "string") return []
      // Tool calls the runtime swept without ever executing say nothing about what a contestant did,
      // and providers that emit malformed tool-call deltas produce them asymmetrically.
      if (record(part.state.metadata) && part.state.metadata.interrupted === true) return []
      return [{ type: "tool", name: part.tool, status: part.state.status }]
    })
    if (content.length === 0) return []
    return [{ role, content }]
  })
  return JSON.stringify(timeline, (_key, value) =>
    typeof value === "string" && hidden.has(value) ? "contestant" : value,
  )
}

type ComparisonTimelineEvent =
  | { readonly type: "narrative"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly status: string }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as ArenaComparisonTimeline from "./comparison-timeline"
