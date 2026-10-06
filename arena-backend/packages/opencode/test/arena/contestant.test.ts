import { describe, expect, test } from "bun:test"
import { contestantPermissions } from "@/arena/contestant"
import { Permission } from "@/permission"

describe("Arena contestant permissions", () => {
  test("denies external directories after inherited allow rules", () => {
    const source = [{ permission: "external_directory", pattern: "*", action: "allow" as const }]
    const permissions = contestantPermissions(source)

    expect(Permission.evaluate("external_directory", "/repo/*", permissions).action).toBe("deny")
    expect(source).toEqual([{ permission: "external_directory", pattern: "*", action: "allow" }])
  })

  test("preserves unrelated source permissions", () => {
    const permissions = contestantPermissions([{ permission: "edit", pattern: "*", action: "allow" }])

    expect(Permission.evaluate("edit", "src/index.ts", permissions).action).toBe("allow")
    expect(Permission.evaluate("external_directory", "/repo/*", permissions).action).toBe("deny")
  })
})
