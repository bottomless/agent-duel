import path from "node:path"
import { Permission } from "@opencode/core/permission"
import { Tool } from "@opencode/schema/tool"
import { Patch } from "@opencode/util/patch"
import { Global } from "@opencode/util/global"
import { Effect, Result } from "effect"
import { resolveExistingPrefix, shellPaths } from "./outside-project"

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
  const blocked = [absolute, resolved].some(
    (file) => Permission.evaluate("external_directory", path.join(file, "*"), rules).effect === "deny",
  )
  if (blocked) return "Arena contestants cannot access other Arena worktrees or another side's temp directory."
  if (operation === "read") return
  if (/^\/dev\/(?:null|std(?:in|out|err)|fd\/\d+)$/.test(resolved)) return

  // Only the sandbox's final reopen rules grant writes. Inherited edit allows cannot widen it.
  const start = rules.findLastIndex((rule) => rule.action === "external_directory" && rule.resource === "*")
  const own = rules
    .slice(start + 1)
    .filter(
      (rule) =>
        rule.action === "edit" &&
        rule.effect === "allow" &&
        path.isAbsolute(rule.resource) &&
        rule.resource.endsWith("/*"),
    )
  if (own.some((rule) => contains(resolveExistingPrefix(rule.resource.slice(0, -2)), resolved))) return
  return "Arena contestants can read the main checkout but write only in their own worktree and their own $TMPDIR."
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
      yield* check("write", targets)
      const patchText = params.patchText.replace(
        /^\s*\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm,
        (_line, operation: string, file: string) => `*** ${operation}: ${absolute(file.trim())}`,
      )
      return { ...params, patchText }
    }
    return args
  })
}
