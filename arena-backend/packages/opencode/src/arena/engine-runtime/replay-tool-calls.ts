import { AssistantMessage, ToolMessage, type Message, type ToolResultPart } from "@opencode/ai"
import { hashCallID } from "../tool-call-id"

/** Keep native IDs for provider replay unless a previous call already owns that ID. Older histories
 * can contain either repeated positional IDs or their repeated blinded hashes. Never edit the rows.
 */
export function replayToolCalls(messages: Message[]): Message[] {
  const used = new Set<string>()
  // Local results follow their assistant; provider-executed results are parts of that assistant.
  // Results from parallel calls need not arrive in call order.
  const pending = new Map<string, string[]>()
  const key = (part: { id: string; name: string }) => JSON.stringify([part.id, part.name])
  const result = (part: ToolResultPart) => {
    const id = pending.get(key(part))?.shift()
    return id === undefined || id === part.id ? part : { ...part, id }
  }

  return messages.map((message, position) => {
    if (message.role === "assistant") {
      pending.clear()
      const content = message.content.map((part, index) => {
        if (part.type === "tool-result") return result(part)
        if (part.type !== "tool-call") return part
        let id = part.id
        // Allocate left to right: appending a new collision cannot change the cached prefix.
        for (let salt = 0; used.has(id); salt++) id = hashCallID(part.id, message.id ?? position, index, salt)
        used.add(id)
        const k = key(part)
        const queue = pending.get(k)
        if (queue) queue.push(id)
        else pending.set(k, [id])
        return id === part.id ? part : { ...part, id }
      })
      return content.some((part, i) => part !== message.content[i])
        ? new AssistantMessage({ ...message, content })
        : message
    }
    if (message.role !== "tool") return message
    const content = message.content.map(result)
    return content.some((part, i) => part !== message.content[i]) ? new ToolMessage({ ...message, content }) : message
  })
}
