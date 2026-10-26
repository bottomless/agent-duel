import type { Assignment, AssignmentRegistry } from "../proxy"

export type ArenaAssignmentRegistry = Pick<AssignmentRegistry, "assignments" | "assign" | "resolve">

/** Resolve a session's assignment and copy it to a child when the child is first observed. */
export function resolveAssignment(
  registry: ArenaAssignmentRegistry,
  sessionID: string,
  parentSessionID?: string,
): Assignment | undefined {
  const existing = registry.assignments.get(sessionID)
  if (existing) return existing
  if (!parentSessionID) return undefined
  return registry.resolve(sessionID, parentSessionID)
}

export function registerChildAssignment(
  registry: ArenaAssignmentRegistry,
  childSessionID: string,
  parentSessionID: string,
) {
  return resolveAssignment(registry, childSessionID, parentSessionID)
}

export function isArenaSession(registry: ArenaAssignmentRegistry, sessionID: string) {
  return registry.assignments.has(sessionID)
}

export * as ArenaEngineAssignment from "./assignment.js"
