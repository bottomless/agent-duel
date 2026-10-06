import type { ArenaPromptAttachments } from "@getpaseo/client/internal/daemon-client";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

interface ArenaStartClient {
  arenaResolve(agentId: string): Promise<ArenaSnapshot>;
  arenaStart(
    agentId: string,
    chatId: string,
    prompt: string,
    attachments?: ArenaPromptAttachments,
  ): Promise<ArenaSnapshot>;
}

export async function resolveAndStartArenaTurn(input: {
  client: ArenaStartClient;
  agentId: string;
  prompt: string;
  attachments?: ArenaPromptAttachments;
  onResolved: (snapshot: ArenaSnapshot) => void;
}): Promise<ArenaSnapshot> {
  const current = await input.client.arenaResolve(input.agentId);
  input.onResolved(current);
  return input.client.arenaStart(input.agentId, current.chat.id, input.prompt, input.attachments);
}
