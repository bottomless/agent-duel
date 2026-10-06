import { describe, expect, test } from "bun:test"
import { canonicalizeWorktreeCommand, localizeCanonicalCommand } from "@/arena/canonical-path"

const root = "/tmp/project"
const worktree = `${root}/.agent-duel/generation-2-a`
const paths = { canonical: root, worktree }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const doubleQuote = (value: string) => `"${value.replace(/[\\"$`]/g, (character) => `\\${character}`)}"`
const escapeBare = (value: string) => value.replace(/[^a-zA-Z0-9_/.-]/g, (character) => `\\${character}`)

async function argumentsOf(command: string) {
  const process = Bun.spawn(["/bin/bash", "--noprofile", "--norc", "-c", `set -f\n${command}`], {
    env: { PATH: "", AUDIT_LITERAL: "expanded" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output, error, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  expect(status, error).toBe(0)
  expect(output.endsWith("\0"), `Incomplete Bash output for ${command}`).toBe(true)
  return output.split("\0").slice(0, -1)
}

describe("Arena literal command paths", () => {
  test("rewrites complete arguments, assignments and redirects", async () => {
    expect(await localizeCanonicalCommand(`ROOT="${root}"; cat "${root}/a" > ${root}/b`, paths)).toBe(
      `ROOT="${worktree}"; cat "${worktree}/a" > '${worktree}/b'`,
    )
  })

  test.each([
    `echo "prefix '${root}' suffix"`,
    `echo '${root} backup'`,
    `cat "${root}",backup`,
    `cat prefix"${root}"`,
    `cat ${root}/../sibling`,
    `echo "${root}/$NAME"`,
    `cat ${root}/*`,
    `cat ${root}/{a,b}`,
    `cat <<'EOF'\n${root}/file\nEOF`,
    `cd "${root}`,
    `echo $(cat ${root}/file)`,
  ])("preserves nonliteral, unrelated or malformed expressions: %s", async (command) => {
    expect(await localizeCanonicalCommand(command, paths)).toBe(command)
  })

  test.skipIf(process.platform === "win32")("preserves a sibling of an apostrophe root", async () => {
    const canonical = "/tmp/p'"
    const command = `printf '%s\\0' ${quote(canonical + " backup")}`
    const mapped = await localizeCanonicalCommand(command, { canonical, worktree: `${canonical}/.wt` })
    expect(mapped).toBe(command)
    expect(await argumentsOf(mapped)).toEqual([canonical + " backup"])
  })

  test.skipIf(process.platform === "win32")("treats line-continuation fragments as one argument", async () => {
    const command = `printf '%s\\0' ${root}\\\nbackup ${root}\\\n/src`
    const mapped = await localizeCanonicalCommand(command, paths)
    expect(await argumentsOf(mapped)).toEqual([root + "backup", worktree + "/src"])
  })

  test.skipIf(process.platform === "win32")("keeps escaped tabs inside the same path argument", async () => {
    const canonical = "/tmp/tab\troot\t"
    const destination = canonical + "/.wt"
    const command = `printf '%s\\0' ${escapeBare(canonical)} ${escapeBare(canonical + "/file")}`
    expect(await argumentsOf(await localizeCanonicalCommand(command, { canonical, worktree: destination }))).toEqual([
      destination,
      destination + "/file",
    ])
  })

  test.skipIf(process.platform === "win32")(
    "checks 1000 seeded shell cases against real Bash and reverse conversion",
    async () => {
      let seed = 20260911
      const random = (n: number) => {
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        return (seed >>> 0) % n
      }
      const names = [
        "normal",
        "with space",
        "apostrophe's",
        'double"quote',
        "back\\slash",
        "$AUDIT_LITERAL",
        "[x]{}",
        "éı",
        "line\nbreak",
      ]
      for (let i = 0; i < 1000; i++) {
        const canonical = "/tmp/" + names[random(names.length)]
        const destination = canonical + "/.agent-duel/generation-2-a"
        const suffix = ["", "/src/file", " backup", ",backup", "]backup", "\n"][random(6)]!
        const quoted = [quote, doubleQuote, escapeBare][random(3)]!
        const expression = random(2) ? quoted(canonical + suffix) : quote(canonical) + quote(suffix)
        const command = `printf '%s\\0' ${expression}`
        const original = await argumentsOf(command)
        const expected = original.map((value) =>
          value === canonical || value.startsWith(canonical + "/")
            ? destination + value.slice(canonical.length)
            : value,
        )
        const mapped = await localizeCanonicalCommand(command, { canonical, worktree: destination })
        expect(await argumentsOf(mapped), JSON.stringify({ i, command, mapped })).toEqual(expected)
        const restored = await canonicalizeWorktreeCommand(mapped, { canonical, worktrees: [destination] })
        expect(await argumentsOf(restored), JSON.stringify({ i, command, mapped, restored })).toEqual(original)
      }
    },
    30000,
  )
})
