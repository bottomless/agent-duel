export * as ConfigImportedSetup from "./imported-setup.js"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import type { ConfigDiscovery } from "./discovery.js"

/**
 * Agent Duel's choice of which of the user's own files reach a session, written by the daemon into
 * the imported config dirs (`packages/server/src/server/agent-plugins/`):
 * `{ "instructions": boolean }` in the global dir covers the global AGENTS.md, ~/.claude/CLAUDE.md
 * and the skills in ~/.claude and ~/.agents; in a project's dir it covers that project's AGENTS.md
 * and CLAUDE.md files.
 */
export const FILE = "agent-duel.json"

export interface Setup {
  readonly project: boolean
  readonly global: boolean
}

/** A project's files load until the user turns them off; the user's global files wait to be turned on. */
export const defaults: Setup = { project: true, global: false }

const readChoice = Effect.fnUntraced(function* (fs: FSUtil.Interface, directory: string) {
  const text = yield* fs.readFileStringSafe(path.join(directory, FILE)).pipe(Effect.orElseSucceed(() => undefined))
  if (text === undefined) return
  const parsed: unknown = yield* Effect.try(() => JSON.parse(text) as unknown).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  if (typeof parsed !== "object" || parsed === null || !("instructions" in parsed)) return
  return typeof parsed.instructions === "boolean" ? parsed.instructions : undefined
})

/** Undefined without an imported config root, where upstream discovery applies unchanged. */
export const read = Effect.fnUntraced(function* (fs: FSUtil.Interface, sources: ConfigDiscovery.Sources) {
  if (!sources.imported) return
  const global = sources.imported.global?.present ? yield* readChoice(fs, sources.imported.global.path) : undefined
  // Outermost first, so the nearest project dir that decided wins.
  let project: boolean | undefined
  for (const root of sources.imported.project) {
    if (!root.present) continue
    project = (yield* readChoice(fs, root.path)) ?? project
  }
  return {
    project: project ?? defaults.project,
    global: global ?? defaults.global,
  } satisfies Setup
})
