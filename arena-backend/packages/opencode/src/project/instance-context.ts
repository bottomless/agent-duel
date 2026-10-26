import { FSUtil } from "@opencode/util/fs-util"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Context } from "effect"
import type { Project } from "@opencode/schema/project"

/** Compatibility projection for callers that still consume the daemon context. */
export interface InstanceProject {
  readonly id: Project.ID
  readonly worktree: string
  readonly vcs?: string
}

export interface InstanceContext {
  readonly directory: string
  readonly worktree: string
  readonly project: InstanceProject
}

/** Current location used by runtime children that need to rebind Core services. */
export const CurrentDirectory = Context.Reference<Location.Ref>("@opencode/CurrentDirectory", {
  defaultValue: () => Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }),
})

export function fromLocation(location: Location.Interface): InstanceContext {
  return {
    directory: location.directory,
    worktree: location.project.directory,
    project: {
      id: location.project.id,
      worktree: location.project.canonical,
      vcs: location.vcs?.type,
    },
  }
}

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (FSUtil.contains(ctx.directory, filepath)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return FSUtil.contains(ctx.worktree, filepath)
}
