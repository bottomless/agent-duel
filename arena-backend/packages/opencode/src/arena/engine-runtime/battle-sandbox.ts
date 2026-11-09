import path from "node:path"
import { statSync } from "node:fs"
import { Permission } from "@opencode/core/permission"
import { Tool } from "@opencode/schema/tool"
import { Patch } from "@opencode/util/patch"
import { Global } from "@opencode/util/global"
import { Effect, Result } from "effect"
import { LOCAL_STATE_DIRNAME } from "@/worktree/layout"
import { sharedTmp, spellings, tmpParent } from "@/arena/contestant"
import { DEVICE_PATH, resolveExistingPrefix, shellPaths, windowsShellPath } from "./outside-project"

function contains(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Core's internal file resources are relative even when they reach the primary Git checkout. */
export function battlePathDenial(
  rules: Permission.Ruleset,
  operation: "read" | "write",
  target: string,
  directory: string,
): string | undefined {
  const absolute = path.isAbsolute(target) ? target : `${directory}/${target}`
  const resolved = resolveExistingPrefix(absolute)
  // Only the sandbox's final reopen rules grant writes. Inherited edit allows cannot widen it.
  // The sandbox joins its rules with the platform's separator, so on Windows they end in `\*`.
  const start = rules.findLastIndex((rule) => rule.action === "external_directory" && rule.resource === "*")
  const own = rules
    .slice(start + 1)
    .filter(
      (rule) =>
        rule.action === "edit" &&
        rule.effect === "allow" &&
        path.isAbsolute(rule.resource) &&
        (rule.resource.endsWith("/*") || rule.resource.endsWith(`${path.sep}*`)),
    )
    .map((rule) => resolveExistingPrefix(rule.resource.slice(0, -2)))
  const blocked = [absolute, resolved].some(
    (file) => Permission.evaluate("external_directory", path.join(file, "*"), rules).effect === "deny",
  )
  if (blocked) {
    // A file beside our worktree is in the battle folder, not in another contestant's area.
    const battleFolder = [path.resolve(absolute), resolved].every((file) =>
      own.some(
        (root) =>
          root.split(path.sep).includes(LOCAL_STATE_DIRNAME) &&
          (contains(file, root) ||
            (contains(path.dirname(file), root) &&
              !target.endsWith(path.sep) &&
              statSync(file, { throwIfNoEntry: false })?.isDirectory() !== true &&
              !file.endsWith(".git"))),
      ),
    )
    if (battleFolder)
      return `Arena contestants cannot ${operation} ${target} in the battle folder. Write only in your own worktree or your own $TMPDIR.`
    return "Arena contestants cannot access other Arena worktrees or another side's temp directory."
  }
  if (operation === "read") return
  if (DEVICE_PATH.test(target) || DEVICE_PATH.test(resolved)) return

  if (own.some((root) => contains(root, resolved))) return
  // Name the way out, as 1.x did: a model told only "write only in your own folders" tries the same
  // write again in other forms (bench 2026-11-06). The temp directory is the contestant's own.
  const temps = spellings(tmpParent())
  const tmp = own.find((root) => temps.some((parent) => contains(parent, root)))
  const cwd = resolveExistingPrefix(directory)
  const worktree = own.find((root) => root !== tmp && contains(root, cwd)) ?? own.find((root) => root !== tmp)
  const inside = (root: string) => contains(root, path.resolve(absolute)) || contains(root, resolved)
  // A worktree lives in `<checkout>/.agent-duel/…`; a checkout write gets the checkout message even
  // when the checkout itself sits in a temp directory.
  const marker = `${path.sep}${LOCAL_STATE_DIRNAME}${path.sep}`
  const checkout = worktree?.includes(marker) ? worktree.slice(0, worktree.indexOf(marker)) : undefined
  const shared = sharedTmp()
    .sort((a, b) => b.length - a.length)
    .find(inside)
  if (shared && tmp && !(checkout && inside(checkout)))
    return `Arena contestants cannot change files in ${shared}, which both sides use while they run. They write only in their own worktree and their own $TMPDIR: use the same name under $TMPDIR (${tmp}) instead.`
  // The worktree path stays out: it names the home directory in transcripts and research uploads.
  const folders = `their own worktree and their own $TMPDIR${tmp ? ` (${tmp})` : ""}`
  return `Arena contestants can read the main checkout but write only in ${folders}. ${target} is outside them.`
}

interface BattleToolInput {
  readonly tool: string
  readonly args: unknown
  readonly directory: string
  readonly rules: Permission.Ruleset
}

export function battleToolInput({ tool, args, directory, rules }: BattleToolInput) {
  return Effect.gen(function* () {
    if (typeof args !== "object" || args === null) return args
    const params = args as Record<string, unknown>
    const absolute = (file: string) => {
      if (file === "~") return Global.Path.home
      if (file.startsWith("~/")) return `${Global.Path.home}/${file.slice(2)}`
      const native = windowsShellPath(file)
      if (native !== file) return native
      return path.isAbsolute(file) ? file : `${directory}/${file}`
    }
    const check = (operation: "read" | "write", targets: readonly string[]) =>
      Effect.gen(function* () {
        for (const target of targets) {
          const message = battlePathDenial(rules, operation, target, directory)
          if (message) return yield* new Tool.Error({ message })
        }
      })
    if (tool === "shell" && typeof params.command === "string") {
      const command = params.command
      const cwd = resolveExistingPrefix(absolute(typeof params.workdir === "string" ? params.workdir : "."))
      yield* check("read", yield* Effect.promise(() => shellPaths(command, cwd, "read")))
      yield* check("write", yield* Effect.promise(() => shellPaths(command, cwd, "write")))
      return { ...params, workdir: cwd }
    }
    if (["write", "edit", "read", "glob", "grep"].includes(tool) && typeof params.path === "string") {
      const target = absolute(params.path)
      yield* check(tool === "write" || tool === "edit" ? "write" : "read", [target])
      return { ...params, path: target }
    }
    if (tool === "patch" && typeof params.patchText === "string") {
      const parsed = Patch.parse(params.patchText)
      if (Result.isFailure(parsed)) return args
      const targets = parsed.success.flatMap((hunk) => [
        hunk.path,
        ...(hunk.type === "update" && hunk.movePath ? [hunk.movePath] : []),
      ])
      yield* check("write", targets.map(absolute))
      const patchText = params.patchText.replace(
        /^\s*\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm,
        (_line, operation: string, file: string) => `*** ${operation}: ${absolute(file.trim())}`,
      )
      return { ...params, patchText }
    }
    return args
  })
}
