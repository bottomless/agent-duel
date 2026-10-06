import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs"
import os from "os"
import path from "path"
import { cloneTree, copyTree } from "@/util/copy-tree"

const directories: string[] = []

function workspace() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "copy-tree-"))
  directories.push(directory)
  return directory
}

function write(root: string, relative: string, contents: string) {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("copyTree", () => {
  test("copies a nested tree and creates missing parents", async () => {
    const root = workspace()
    write(root, "source/lib/index.js", "module.exports = 1")

    const result = await copyTree(path.join(root, "source"), path.join(root, "nested/deep/target"))

    expect(result).not.toBe("skipped")
    expect(readFileSync(path.join(root, "nested/deep/target/lib/index.js"), "utf8")).toBe("module.exports = 1")
  })

  test("leaves an existing target alone", async () => {
    const root = workspace()
    write(root, "source/file.txt", "from source")
    write(root, "target/file.txt", "already here")

    expect(await copyTree(path.join(root, "source"), path.join(root, "target"))).toBe("skipped")
    expect(readFileSync(path.join(root, "target/file.txt"), "utf8")).toBe("already here")
  })

  test("the copy is independent of the source", async () => {
    const root = workspace()
    write(root, "source/file.txt", "original")
    await copyTree(path.join(root, "source"), path.join(root, "target"))

    writeFileSync(path.join(root, "source/file.txt"), "changed")

    expect(readFileSync(path.join(root, "target/file.txt"), "utf8")).toBe("original")
  })

  test("keeps scoped packages, links, and directory modes and times when cloning child by child", async () => {
    const root = workspace()
    write(root, "source/plain/index.js", "plain")
    write(root, "source/@scope/pkg/index.js", "scoped")
    write(root, "source/.bin/.keep", "")
    symlinkSync("../plain/index.js", path.join(root, "source/.bin/plain"))
    chmodSync(path.join(root, "source/@scope"), 0o750)
    chmodSync(path.join(root, "source"), 0o755)
    const past = new Date("2001-02-03T04:05:06Z")
    utimesSync(path.join(root, "source/@scope"), past, past)
    utimesSync(path.join(root, "source"), past, past)

    const result = await copyTree(path.join(root, "source"), path.join(root, "target"))

    expect(result).not.toBe("skipped")
    expect(readFileSync(path.join(root, "target/plain/index.js"), "utf8")).toBe("plain")
    expect(readFileSync(path.join(root, "target/@scope/pkg/index.js"), "utf8")).toBe("scoped")
    expect(readlinkSync(path.join(root, "target/.bin/plain"))).toBe("../plain/index.js")
    expect(lstatSync(path.join(root, "target/.bin/plain")).isSymbolicLink()).toBe(true)
    expect(statSync(path.join(root, "target/@scope")).mode & 0o777).toBe(0o750)
    expect(statSync(path.join(root, "target")).mode & 0o777).toBe(0o755)
    if (result === "cloned") {
      expect(statSync(path.join(root, "target")).mtime.getTime()).toBe(past.getTime())
      expect(statSync(path.join(root, "target/@scope")).mtime.getTime()).toBe(past.getTime())
    }
  })

  test("builds a staged tree outside the target and moves it in whole", async () => {
    const root = workspace()
    write(root, "source/plain/index.js", "plain")
    write(root, "source/@scope/pkg/index.js", "scoped")
    const staging = path.join(root, "staging")

    const method = await cloneTree(path.join(root, "source"), path.join(root, "target"), { staging })
    if (!method) return

    expect(readFileSync(path.join(root, "target/@scope/pkg/index.js"), "utf8")).toBe("scoped")
    expect(readdirSync(staging)).toEqual([])
  })

  test("stops a staged clone partway and leaves neither the target nor the staged tree", async () => {
    const root = workspace()
    for (let index = 0; index < 4000; index++) write(root, `source/pkg-${index}/index.js`, String(index))
    const staging = path.join(root, "staging")
    const controller = new AbortController()
    const stopped = new Error("stopped")
    const started = performance.now()
    const cloning = cloneTree(path.join(root, "source"), path.join(root, "target"), {
      staging,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(stopped), 20)

    await expect(cloning).rejects.toBe(stopped)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(() => lstatSync(path.join(root, "target"))).toThrow()
    for (let attempt = 0; attempt < 100 && readdirSync(staging).length > 0; attempt++) await Bun.sleep(20)
    expect(readdirSync(staging)).toEqual([])
  })

  test("does not start a clone once stopped", async () => {
    const root = workspace()
    write(root, "source/file.txt", "text")
    const controller = new AbortController()
    controller.abort(new Error("stopped first"))

    await expect(
      cloneTree(path.join(root, "source"), path.join(root, "target"), { signal: controller.signal }),
    ).rejects.toThrow("stopped first")
    expect(() => lstatSync(path.join(root, "target"))).toThrow()
  })
})
