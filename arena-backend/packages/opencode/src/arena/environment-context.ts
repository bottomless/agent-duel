import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { rewritePortCommand } from "./path-command"

const ALIASES = ["PASEO_PORT", "PASEO_PORT2", "PASEO_PORT3"] as const
type Alias = (typeof ALIASES)[number]
export interface Environment {
  readonly portAliases?: Partial<Record<Alias, number>>
  readonly previewUrls?: Partial<Record<Alias, string>>
}

const URL_TOOLS = new Set([
  "webfetch",
  "paseo_browser_navigate",
  "browser_navigate",
  "paseo_browser_new_tab",
  "browser_new_tab",
])

export function isEnvironmentTool(tool: string) {
  return tool === "bash" || URL_TOOLS.has(tool)
}

/** Apply only known endpoint arguments; arbitrary payload fields remain byte-for-byte data. */
export async function retargetToolInput(
  tool: string,
  input: Record<string, unknown>,
  mapping: ReturnType<typeof environmentReferences>,
) {
  if (tool === "bash" && typeof input.command === "string") {
    const mapped = await rewritePortCommand(input.command, mapping)
    return mapped.command === input.command ? input : { ...input, command: mapped.command }
  }
  if (URL_TOOLS.has(tool) && typeof input.url === "string") {
    const url = mapping.endpoint(input.url)
    return url === input.url ? input : { ...input, url }
  }
  return input
}

export function environmentReferences(history: readonly Environment[], current: Environment) {
  const ports = new Map<string, Set<Alias>>()
  const origins = new Map<string, Set<Alias>>()
  const add = (map: Map<string, Set<Alias>>, key: string, alias: Alias) => {
    const aliases = map.get(key) ?? new Set<Alias>()
    aliases.add(alias)
    map.set(key, aliases)
  }
  for (const environment of history) {
    for (const alias of ALIASES) {
      const port = environment.portAliases?.[alias]
      const url = environment.previewUrls?.[alias]
      if (port) add(ports, String(port), alias)
      if (url) {
        try {
          add(origins, new URL(url).origin, alias)
        } catch {
          /* Ignore malformed historical route records. */
        }
      }
    }
  }
  const unique = (map: Map<string, Set<Alias>>, key: string) => {
    const values = map.get(key)
    return values?.size === 1 ? [...values][0] : undefined
  }
  const port = (value: string) => {
    const alias = unique(ports, value)
    return alias && current.portAliases?.[alias] ? String(current.portAliases[alias]) : value
  }
  const endpoint = (value: string) => {
    // Replace only the authority. URL serialization would also change path/query escaping.
    if (/\s/.test(value)) return value
    const match = /^(?:(https?|wss?):\/\/|\/\/)?(\[[^\]]+\]|[a-z0-9.%_-]+)(?::(\d+))?(?=[/?#]|$)/i.exec(value)
    if (!match) return value
    const [, rawScheme, host, number] = match
    const scheme = rawScheme?.toLowerCase()
    const relative = value.startsWith("//")
    const authority = match[0]
    const suffix = value.slice(authority.length)
    const origin = `${scheme === "ws" ? "http" : scheme === "wss" ? "https" : (scheme ?? "http")}://${host}${number ? `:${number}` : ""}`
    let alias: Alias | undefined
    let parsed: URL
    try {
      parsed = new URL(origin)
      alias = unique(origins, parsed.origin)
    } catch {
      return value
    }
    if (alias) {
      const destination = current.previewUrls?.[alias]
      if (!destination) return value
      const target = new URL(destination)
      const protocol =
        scheme === "ws" || scheme === "wss" ? (target.protocol === "https:" ? "wss:" : "ws:") : target.protocol
      return `${scheme ? `${protocol}//` : relative ? "//" : ""}${target.host}${suffix}`
    }
    if (!number || !["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(parsed.hostname.toLowerCase())) return value
    const normalizedPort = String(Number(number))
    const mapped = port(normalizedPort)
    return mapped === normalizedPort
      ? value
      : `${scheme ? `${scheme}://` : relative ? "//" : ""}${host}:${mapped}${suffix}`
  }
  const token = (value: string) => {
    const punctuation = /[),.;!?]+$/.exec(value)?.[0] ?? ""
    return endpoint(punctuation ? value.slice(0, -punctuation.length) : value) + punctuation
  }
  const urls = (text: string) =>
    text.replace(
      // Consume opaque data URIs and whole external URLs so their embedded strings cannot match.
      /(?<![\w@/])(?:(?:[a-z][a-z0-9+.-]*:|\/\/)[^\s<>"'`]+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s<>"'`]*)/gi,
      (value: string, offset: number) => {
        if (value.toLowerCase().startsWith("data:")) return value
        // A URL label and its link destination are two endpoints, not one URL path.
        const boundary = text[offset - 1] === "[" ? value.indexOf("](") : -1
        if (boundary >= 0) return endpoint(value.slice(0, boundary)) + "](" + token(value.slice(boundary + 2))
        return token(value)
      },
    )
  return { port, endpoint, urls }
}

// Preserve Markdown code boundaries, including longer delimiters and incomplete fences.
// Nested/list fences and indented code are opaque; only explicit top-level shell fences execute.
async function retargetText(text: string, mapping: ReturnType<typeof environmentReferences>) {
  const inline = async (text: string) => {
    const chunks: string[] = []
    const delimiters = /`+/g
    let cursor = 0
    for (let opening = delimiters.exec(text); opening; opening = delimiters.exec(text)) {
      const escapes = /\\+$/.exec(text.slice(0, opening.index))?.[0].length ?? 0
      if (escapes % 2) continue
      chunks.push(mapping.urls(text.slice(cursor, opening.index)))
      const start = delimiters.lastIndex
      let closing = delimiters.exec(text)
      while (closing && closing[0] !== opening[0]) closing = delimiters.exec(text)
      if (!closing) {
        chunks.push(text.slice(opening.index))
        return chunks.join("")
      }
      const code = text.slice(start, closing.index)
      const endpoint = mapping.endpoint(code)
      const mapped = endpoint === code ? (await rewritePortCommand(code, mapping)).command : endpoint
      chunks.push(opening[0] + mapped + closing[0])
      cursor = delimiters.lastIndex
    }
    chunks.push(mapping.urls(text.slice(cursor)))
    return chunks.join("")
  }
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const chunks: Promise<string>[] = []
  let prose = ""
  const flush = () => {
    if (prose) chunks.push(inline(prose))
    prose = ""
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const opening = /^((?:[ \t]*>[ \t]*)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?)(`{3,}|~{3,})([^\r\n]*)(?:\r?\n)?$/.exec(
      line,
    )
    if (opening) {
      flush()
      let end = index + 1
      for (; end < lines.length; end++) {
        const closing = /^(?:[ \t]*>[ \t]*)*[ \t]*([`~]{3,})[ \t]*(?:\r?\n)?$/.exec(lines[end])
        if (closing && closing[1].length >= opening[2].length && closing[1] === opening[2][0].repeat(closing[1].length))
          break
      }
      const body = lines.slice(index + 1, end).join("")
      const shell = end < lines.length && /^ {0,3}$/.test(opening[1]) && /^(bash|sh|shell)$/.test(opening[3].trim())
      chunks.push(
        shell
          ? rewritePortCommand(body, mapping).then((result) => line + result.command + lines[end])
          : Promise.resolve(lines.slice(index, Math.min(end + 1, lines.length)).join("")),
      )
      index = end
    } else if (/^(?:(?:[ \t]*>[ \t]?)+)?(?: {4}|\t)/.test(line)) {
      flush()
      chunks.push(Promise.resolve(line))
    } else {
      prose += line
    }
  }
  flush()
  return (await Promise.all(chunks)).join("")
}

/** Only model-facing copies pass here. Attachments, metadata and arbitrary tool payloads are opaque. */
export async function retargetPart<T extends SessionV1.Part>(
  part: T,
  mapping: ReturnType<typeof environmentReferences>,
): Promise<T> {
  if (part.type === "text") {
    const text = await retargetText(part.text, mapping)
    return text === part.text ? part : { ...part, text }
  }
  if (part.type !== "tool") return part
  const state = part.state
  if (part.tool === "bash" && typeof state.input.command === "string") {
    const mapped = await rewritePortCommand(state.input.command, mapping)
    return {
      ...part,
      state: {
        ...state,
        input: { ...state.input, command: mapped.command },
      },
    }
  }
  if (URL_TOOLS.has(part.tool) && typeof state.input.url === "string") {
    return { ...part, state: { ...state, input: { ...state.input, url: mapping.endpoint(state.input.url) } } }
  }
  return part
}

export async function retargetMessages(
  input: SessionV1.WithParts[],
  history: readonly Environment[],
  current: Environment,
  before: number,
) {
  const mapping = environmentReferences(history, current)
  return Promise.all(
    input.map(async (message) => {
      if (message.info.role !== "assistant" || message.info.time.created >= before) return message
      return { ...message, parts: await Promise.all(message.parts.map((part) => retargetPart(part, mapping))) }
    }),
  )
}
