import type { SessionMessageInfo } from "@opencode/client";
import type { V2Api } from "./api.js";

export async function messages(client: V2Api, sessionID: string): Promise<SessionMessageInfo[]> {
  const result: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.message.list({
      sessionID,
      ...(cursor ? { cursor } : { order: "asc" }),
      limit: 100,
    });
    result.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return result;
}

/**
 * OpenCode forks up to an exclusive message; the daemon selects the last message the fork keeps.
 * The boundary is the message after it, or none when it was the last.
 */
export async function exclusiveForkBoundary(
  client: V2Api,
  sessionID: string,
  throughMessageID: string,
): Promise<string | undefined> {
  const all = await messages(client, sessionID);
  const through = all.findIndex((message) => message.id === throughMessageID);
  if (through < 0) throw new Error("The selected source message is no longer available");
  return all[through + 1]?.id;
}
