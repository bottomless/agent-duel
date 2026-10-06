// A battle's chat worktree is created as `chat-<16 hex of sha256(chatId)>`, which
// OpenCode parks on an `opencode/`-prefixed branch — and appends `-<slug>` if that
// name is taken. Nobody switches a checkout to one, so they stay out of branch
// pickers. Sessions a person started themselves live under the same prefix with a
// name they chose, and those belong in the list.
const ARENA_CHAT_BRANCH = /^opencode\/chat-[0-9a-f]{16}(-.+)?$/;

export function isArenaInternalBranch(branchName: string): boolean {
  return ARENA_CHAT_BRANCH.test(branchName.trim());
}
