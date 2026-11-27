import { createHash } from "crypto"
import { realpathSync } from "fs"
import { homedir } from "os"
import path from "path"
import { Effect } from "effect"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Plugin } from "@opencode/core/plugin"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import type { LoadedSetup } from "./records"

// Discovery reports resolved paths, so compare against resolved roots (`/tmp` is `/private/tmp`).
function resolved(directory: string) {
  try {
    return realpathSync(directory)
  } catch {
    return directory
  }
}

interface Roots {
  readonly worktree: string
  readonly imported: string | undefined
  readonly home: string
  /** The folders the global switch covers: ~/.claude, ~/.agents and OpenCode's global config. */
  readonly personal: readonly string[]
}

const within = (file: string, root: string) => file === root || file.startsWith(root + path.sep)

/**
 * Where a file came from, without the user's name: worktree-relative for the project's own files,
 * `~/`-relative for the user's own, and a file name for anything else. The record is mirrored to
 * research, so it never carries an absolute path or the names of the user's other folders.
 */
function origin(file: string, roots: Roots) {
  if (within(file, roots.worktree)) return { scope: "project" as const, path: path.relative(roots.worktree, file) }
  if (roots.imported && within(file, roots.imported)) {
    return { scope: "imported" as const, path: path.relative(roots.imported, file) }
  }
  if (roots.personal.some((root) => within(file, root))) {
    return { scope: "personal" as const, path: `~/${path.relative(roots.home, file)}` }
  }
  return { scope: "other" as const, path: path.basename(file) }
}

const digest = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16)

/**
 * The instruction files and skills the engine loaded for a contestant's worktree, so battles with
 * and without the user's own setup can be told apart. Hashes, not contents: the record names what
 * loaded without copying it.
 */
export const captureLoadedSetup = Effect.fn("Arena.captureLoadedSetup")(function* (
  locations: LocationServiceMap.Service["Service"],
  worktree: string,
) {
  const imported = process.env.AGENT_DUEL_IMPORTED_CONFIG
  const home = resolved(homedir())
  const roots: Roots = {
    worktree: resolved(worktree),
    imported: imported ? resolved(imported) : undefined,
    home,
    personal: [
      path.join(home, ".claude"),
      path.join(home, ".agents"),
      resolved(path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode")),
    ],
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Plugin.awaitActivation
      const files = yield* (yield* InstructionDiscovery.Service).list()
      const skills = yield* (yield* Skill.Service).list()
      return {
        instructions: Array.isArray(files)
          ? files.map((file) => ({ ...origin(file.path, roots), sha256: digest(file.content) }))
          : "unavailable",
        skills: skills
          .map((skill) => ({ name: skill.name, scope: origin(skill.path, roots).scope }))
          .toSorted((a, b) => a.name.localeCompare(b.name)),
      } satisfies LoadedSetup
    }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(worktree) })))),
  )
})
