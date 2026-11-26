import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { userTmp } from "../src/user-tmp.js"

const linux = process.platform !== "darwin" && process.platform !== "win32"
const created: string[] = []
const app = () => {
  const name = `opencode-user-tmp-test-${process.pid}-${created.length}`
  created.push(path.join(os.tmpdir(), `${name}-${process.getuid?.()}`))
  return name
}

afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe.skipIf(!linux)("userTmp", () => {
  test("creates a directory only this user can enter", () => {
    const directory = userTmp(app(), "/fallback")
    expect(directory).toBe(created[0])
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
  })

  test("reuses its own private directory", () => {
    const name = app()
    expect(userTmp(name, "/fallback")).toBe(userTmp(name, "/fallback"))
  })

  test("refuses a directory open to other users", () => {
    const name = app()
    fs.mkdirSync(created[0], { mode: 0o777 })
    fs.chmodSync(created[0], 0o777)
    expect(userTmp(name, "/fallback")).toBe("/fallback")
  })

  test("refuses a symlink planted in its place", () => {
    const name = app()
    fs.symlinkSync(os.tmpdir(), created[0])
    expect(userTmp(name, "/fallback")).toBe("/fallback")
  })
})
