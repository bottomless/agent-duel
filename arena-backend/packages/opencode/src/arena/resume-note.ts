import { createHash } from "node:crypto"

export const BATTLE_RESUME_MESSAGE_PREFIX = "msg_arena_resume_"

export function battleResumeInput(sessionID: string, battleID: string) {
  const identity = createHash("sha256")
    .update(JSON.stringify([sessionID, battleID]))
    .digest("hex")
  return {
    id: `${BATTLE_RESUME_MESSAGE_PREFIX}${identity}`,
    text: "The engine restarted. Check the current state before you run a step again.",
  }
}
