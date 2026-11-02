import { describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Permission } from "@opencode/core/permission"
import { Agent } from "@opencode/schema/agent"
import { Global } from "@opencode/util/global"
import { Effect, Schema, Stream } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Tool } from "@opencode/schema/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { AssignmentRegistry } from "@/arena/proxy"
import { createArenaEnginePlugin, permissionRules, sandboxForSession } from "@/arena/engine-runtime"
import { askOutsideProject, isTrusted, shellOutsideDirectories } from "@/arena/engine-runtime/outside-project"

const OUT = "/outside/dir"
const project = "/work/project"
const outside = (command: string, cwd = project) => shellOutsideDirectories(command, cwd, [project])

function rules(id: string, ...extra: Permission.Ruleset) {
  const list = [...Agent.Info.default(Agent.ID.make(id)).permissions, ...extra] as Permission.Rule[]
  askOutsideProject(list as never)
  return list
}

describe("external_directory for agents", async () => {
  it("asks on the default rules, and only for that action", async () => {
    const list = rules("build")
    expect(Permission.evaluate("external_directory", `${OUT}/*`, list).effect).toBe("ask")
    expect(Permission.evaluate("edit", "a.txt", list).effect).toBe("allow")
    expect(Permission.evaluate("shell", "echo hi", list).effect).toBe("allow")
    expect(Permission.evaluate("read", ".env", list).effect).toBe("ask")
  })

  it("turns Explore's allow into ask and keeps its deny for other tools", async () => {
    const list = rules(
      "explore",
      { action: "*", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "allow" },
    )
    expect(Permission.evaluate("external_directory", `${OUT}/*`, list).effect).toBe("ask")
    expect(Permission.evaluate("edit", "a.txt", list).effect).toBe("deny")
  })

  it("leaves an agent that denies everything alone", async () => {
    const list = rules("title", { action: "*", resource: "*", effect: "deny" })
    expect(Permission.evaluate("external_directory", `${OUT}/*`, list).effect).toBe("deny")
  })

  it("lets a later rule and a saved approval win", async () => {
    const list = rules("build")
    const later = [...list, { action: "external_directory", resource: `${OUT}/*`, effect: "allow" as const }]
    expect(Permission.evaluate("external_directory", `${OUT}/*`, later).effect).toBe("allow")
  })

  it("never asks a contestant", async () => {
    const sandbox = sandboxForSession("ses_a", "/work/project/.agent-duel/a", "/work/project")
    const list = [...rules("build"), ...permissionRules([], sandbox)]
    expect(Permission.evaluate("external_directory", `${OUT}/*`, list).effect).toBe("allow")
  })
})

describe("directories that never ask", async () => {
  it("covers tool output, shell output, temp, plans, uploads, and skills", async () => {
    const uploads = process.env.PASEO_HOME?.trim() || path.join(Global.Path.home, ".paseo")
    for (const directory of [
      path.join(Global.Path.data, "tool-output"),
      path.join(Global.Path.data, "shell", "project"),
      Global.Path.tmp,
      "/tmp",
      "/var/tmp",
      path.join(Global.Path.home, ".opencode", "plan"),
      path.join(uploads, "uploads", "id"),
      "/skills/review",
    ])
      expect(isTrusted([path.join(directory, "*")], ["/skills/review/SKILL.md"])).toBe(true)
  })

  it("does not cover the engine's data directory or a sibling", async () => {
    expect(isTrusted([path.join(Global.Path.data, "*")], [])).toBe(false)
    expect(isTrusted([path.join(`${Global.Path.data}/tool-output-old`, "*")], [])).toBe(false)
    expect(isTrusted([`${OUT}/*`, path.join(Global.Path.tmp, "*")], [])).toBe(false)
  })
})

describe("shell paths outside the project", async () => {
  it.each([
    [`echo two > ${OUT}/x`],
    [`echo two >${OUT}/x 2>&1`],
    [`echo two >> ${OUT}/x`],
    [`echo two &> ${OUT}/x`],
    [`>${OUT}/x echo hi`],
    [`(echo a > ${OUT}/x)`],
    [`if true; then echo a > ${OUT}/x; fi`],
    [`for f in a; do echo $f > ${OUT}/x; done`],
    [`cat > ${OUT}/x <<EOF\nhi\nEOF`],
    [`echo a | tee ${OUT}/x`],
    [`touch ${OUT}/x`],
    [`cp a.txt ${OUT}/x`],
    [`rm -rf ${OUT}/x`],
    [`dd if=a of=${OUT}/x`],
    [`curl -o ${OUT}/x https://example.com/a`],
    [`sed -i '' s/a/b/ ${OUT}/x`],
    [`sh -c 'echo a > ${OUT}/x'`],
    [`python3 -c "open('${OUT}/x','w')"`],
    [`echo a > "${OUT}/x"`],
  ])("asks for %s", async (command) => {
    expect(await outside(command)).toEqual([`${OUT}/*`])
  })

  it("names a parent path, a home path, and a directory that exists", async () => {
    expect(await outside("touch ../sibling/x")).toEqual(["/work/sibling/*"])
    expect(await outside("echo a > ~/x")).toEqual([path.join(realpathSync(Global.Path.home), "*")])
    expect(await outside("echo a > $HOME/x")).toEqual([path.join(realpathSync(Global.Path.home), "*")])
    const root = mkdtempSync(path.join(os.tmpdir(), "outside-"))
    mkdirSync(path.join(root, "sub"))
    expect(await outside(`rm -rf ${root}/sub`)).toEqual([path.join(realpathSync(root), "sub", "*")])
  })

  it.each([
    ["echo two > inside.txt"],
    [`echo two > ${project}/inside.txt`],
    ["echo a 2>/dev/null"],
    ["echo a > /dev/stderr 2>&1"],
    ["echo a >&2"],
    ["touch src/a.txt"],
    ["gcc -osrc/x a.c"],
    ["curl -sSLo./src/x u"],
    ["wget -qO./src/x u"],
    ["tar -xzC./src -f a"],
    ["rm -rf ./build"],
    ["cat <<EOF > note.txt\nhi\nEOF"],
    ["/usr/bin/env node script.js"],
    ["curl -s https://example.com/a/b"],
    ["curl -s localhost:3000/api/x"],
    ["sed -i '' s/a/b/ src/a.txt"],
    ["git status"],
    ["cat /etc/hosts"],
    ["ls /usr/bin"],
    ["grep -r '/api/x' src"],
    ["echo /not/a/write"],
  ])("does not ask for %s", async (command) => {
    expect(await outside(command)).toEqual([])
  })

  it("follows cd for relative paths", async () => {
    expect(await outside("cd src/deep && cp a.txt ../b.txt")).toEqual([])
    expect(await outside("cd src && cp a.txt ../../sibling/b.txt")).toEqual(["/work/sibling/*"])
    expect(await outside("cp a.txt ../b.txt", `${project}/src/deep`)).toEqual([])
  })

  it("asks conservatively when a command cannot be parsed", async () => {
    expect(await outside(`echo 'open > ${OUT}/x`)).toContain("/*")
  })

  it("cannot see a path a variable holds or a script computes", async () => {
    expect(await outside('echo a > "$OUT/x"')).toEqual([])
    expect(await outside("python3 write.py")).toEqual([])
  })
})

describe("a lone slash (round 2, issue 1)", async () => {
  it.each([
    ["git commit --allow-empty -m 'A / B test'"],
    ["tr / _ < a.txt"],
    ["cut -d '/' -f1 a.txt"],
    ["cut -d/ -f1 a.txt"],
    ["expr 4 / 2"],
    ['python3 -c "print(4 / 2)"'],
    ['node -e "console.log(4 / 2)"'],
    ["python3 -c \"print('a/b'.split('/'))\""],
    ['echo "a > /b"'],
    ['echo "<a>/about</a>"'],
    ['curl -s localhost:3000 -d \'{"path":"/x"}\''],
    ["cat > page.html <<'EOF'\n<a>/about</a>\nEOF"],
  ])("does not read it as the root in %s", async (command) => {
    expect(await outside(command)).toEqual([])
  })

  it.each([
    ["rm -rf /"],
    ["cp a.txt /"],
    ["touch /x"],
    ["sudo chmod -R 777 /"],
    ["tar -C / -xf a.tar"],
    ["echo a > /x"],
    ["sh -c 'rm -rf /'"],
    ["sh -c 'rm -rf / && echo a'"],
    ["python3 -c \"import os; os.system('rm -rf /')\""],
  ])("still asks for a real root path in %s", async (command) => {
    expect(await outside(command)).toEqual(["/*"])
  })

  it("reads a trailing slash as the directory itself", async () => {
    expect(await outside("npm test -- --grep /foo/")).toEqual(["/foo/*"])
    expect(await outside(`cp a.txt ${OUT}/`)).toEqual([`${OUT}/*`])
  })

  it.each([
    ["/*"],
    ["/**"],
    ["*"],
    [path.join(Global.Path.home, "*")],
    [path.join(path.dirname(Global.Path.home), "*")],
  ])("refuses to save %s", (resource) => {
    expect(Permission.tooWideToSave("external_directory", resource)).toBe(true)
  })

  it("saves a real directory, and other actions keep their own wide saves", async () => {
    expect(Permission.tooWideToSave("external_directory", `${OUT}/*`)).toBe(false)
    expect(Permission.tooWideToSave("external_directory", path.join(Global.Path.home, "work", "*"))).toBe(false)
    expect(Permission.tooWideToSave("edit", "*")).toBe(false)
    expect(Permission.tooWideToSave("shell", "/*")).toBe(false)
  })
})

describe("paths that are not at the start of a word (round 2, issue 2)", async () => {
  it("resolves a .. segment inside a word", async () => {
    expect(await outside("cp a.txt src/../../sib.txt")).toEqual(["/work/*"])
    expect(await outside("touch ./../sib.txt")).toEqual(["/work/*"])
    expect(await outside("touch src/deep/../../../sib/x")).toEqual(["/work/sib/*"])
    expect(await outside(`sh -c 'cp a src/../../sib/x'`)).toEqual(["/work/sib/*"])
  })

  it("does not ask when the resolved path is inside", async () => {
    expect(await outside("cp a.txt src/../b.txt")).toEqual([])
    expect(await outside("touch ./src/../x")).toEqual([])
    expect(await outside("git diff main..feature")).toEqual([])
  })

  it.each([
    [`curl -o${OUT}/x https://example.com/a`],
    [`gcc -o${OUT}/x a.c`],
    [`tar -C${OUT}/x -xf a.tar`],
    [`tool --out=${OUT}/x`],
    [`tool --paths=a,${OUT}/x`],
    [`docker run -v ${OUT}/x:/data img`],
    [`curl -o ${OUT}/x https://example.com/a`],
  ])("reads an attached path in %s", async (command) => {
    expect(await outside(command)).toContain(`${OUT}/*`)
  })

  it("reads an attached .. path", async () => {
    expect(await outside("tar -C../sib -xf a.tar")).toEqual(["/work/*"])
    expect(await outside("gcc -osrc/../../x a.c")).toEqual(["/work/*"])
  })
})

describe("text that is not a path (round 2, issue 3)", async () => {
  it.each([
    ["git commit --allow-empty -m 'fix /api/users route'"],
    ["git commit -m '/api/users fix'"],
    ["git commit -m/api/users"],
    ["git commit --message=/api/users"],
    ['gh pr create --title /x --body "calls /api/x"'],
    ["git log --grep=/api/x"],
    ["sed -n '/foo/p' a.txt"],
    ["sed -n /foo/p a.txt"],
    ["sed -e '/foo/d' -e 's/a/b/g' a.txt"],
    ["awk '/foo/ {print $1}' a.txt"],
    ["awk -F/ '{print $1}' a.txt"],
    ["awk -F / '/foo/ {print $1}' a.txt"],
    ["cat > a.ts <<'EOF'\nconst x = /foo/\nEOF"],
    ["tee note.md <<EOF\nSee /etc/hosts\nEOF"],
    ["cat > a.sh <<'EOF'\necho a > /var/log/x\nEOF"],
    ["git commit -F- <<EOF\nfix /api/x\nEOF"],
    ["PATH=/opt/bin npm test"],
  ])("does not ask for %s", async (command) => {
    expect(await outside(command)).toEqual([])
  })

  it.each([
    [`sed -i '/x/d' ${OUT}/x`],
    [`sed -i '' s/a/b/ ${OUT}/x`],
    [`sed 's/a/b/w ${OUT}/x' a.txt`],
    [`sed '/a/w ${OUT}/x' a.txt`],
    [`sed -f ${OUT}/x a.txt`],
    [`awk '{print > "${OUT}/x"}' a.txt`],
    [`awk 'BEGIN {system("touch ${OUT}/x")}'`],
    [`awk '/foo/' ${OUT}/x`],
    [`git -C ${OUT}/x status`],
    [`git commit -m msg ${OUT}/x`],
    [`sudo sh -c 'echo a > ${OUT}/x'`],
    [`echo "$(echo a > ${OUT}/x)"`],
    ['echo "`echo a > ' + OUT + '/x`"'],
    [`cat <<EOF > ${OUT}/x\nhi\nEOF`],
    [`echo a >& ${OUT}/x`],
    [`echo a >&${OUT}/x`],
    [`eval 'echo a > ${OUT}/x'`],
    [`node -e "require('fs').writeFileSync(\`${OUT}/x\`,'a')"`],
    [`python3 -c "print('${OUT}/x')"`],
  ])("keeps the card for %s", async (command) => {
    expect(await outside(command)).toEqual([`${OUT}/*`])
  })
})

describe("a path with a space (round 2, issue 4)", async () => {
  it.each([
    [`touch "${OUT}/with space/q.txt"`],
    [`touch '${OUT}/with space/q.txt'`],
    [`touch ${OUT}/with\\ space/q.txt`],
    [`echo a > "${OUT}/with space/q.txt"`],
    [`echo a > ${OUT}/with\\ space/q.txt`],
    [`sh -c 'touch "${OUT}/with space/q.txt"'`],
    [`python3 -c "open('${OUT}/with space/q.txt','w')"`],
  ])("names the real directory for %s", async (command) => {
    expect(await outside(command)).toEqual([`${OUT}/with space/*`])
  })

  it("does not widen a space at the root", async () => {
    expect(await outside('touch "/outside dir/x"')).toEqual(["/outside dir/*"])
  })
})

describe("one card for one command (round 2, issue 5)", async () => {
  it("asks once for cwd and the cd targets with their sequential state", async () => {
    expect(await outside(`cd ${OUT} && touch ${OUT}/x`)).toEqual([`${OUT}/*`])
    expect(await outside(`cd ${OUT} && touch ${OUT}/sub/x`)).toEqual([`${OUT}/*`, `${OUT}/sub/*`])
    expect(await outside(`cd -P ${OUT} && touch ${OUT}/x`)).toEqual([`${OUT}/*`])
    expect(await outside(`pushd ${OUT} && touch x`)).toEqual([`${OUT}/*`])
    expect(await outside(`touch ${OUT}/x`, OUT)).toEqual([`${OUT}/*`])
  })

  it("still asks for a different directory", async () => {
    expect(await outside(`cd ${OUT} && touch /other/x`)).toEqual([`${OUT}/*`, "/other/*"])
    expect(await outside(`cd ${OUT}/a && touch ${OUT}/x`)).toEqual([`${OUT}/a/*`, `${OUT}/*`])
    expect(await outside(`cd src && touch ${OUT}/x`)).toEqual([`${OUT}/*`])
    expect(await outside(`touch /other/x`, OUT)).toEqual([`${OUT}/*`, "/other/*"])
  })
})

describe("round 3: redirects on every shell node", async () => {
  it.each([
    `true && echo a > ${OUT}/x`,
    `(echo a) > ${OUT}/x`,
    `echo a | cat > ${OUT}/x`,
    `cd src && echo a > ${OUT}/x`,
    `{ echo a; } > ${OUT}/x`,
    `for i in 1; do echo a; done > ${OUT}/x`,
  ])("asks for %s", async (command) => {
    expect(await outside(command)).toEqual([`${OUT}/*`])
  })
})

describe("round 3: literal forms and shell scope", () => {
  it.each([
    [`curl -sSLo${OUT}/x u`],
    [`wget -qO${OUT}/x u`],
    [`tar -xzC${OUT}/x -f a`],
    [`sh -c 'curl -o${OUT}/x u'`],
    [`sh -c 'tar -xzC${OUT}/x -f a'`],
    [`sed -e's/a/b/w ${OUT}/x' a`],
    [`sed --expression='w ${OUT}/x' a`],
    [`sed 's/a/b/w${OUT}/x' a`],
    [`touch {${OUT}/x,y}`],
    [`echo a > $'${OUT}/x'`],
    [`csh -c 'touch ${OUT}/x'`],
    [`tcsh -c 'touch ${OUT}/x'`],
    [`echo a > inside > ${OUT}/x`],
    [`cd src && echo a | cat > ${OUT}/x`],
    [`cd src && { echo a; } > ${OUT}/x`],
    [`true && cat <<EOF > ${OUT}/x\nhi\nEOF`],
  ])("asks for %s", async (command) => {
    expect(await outside(command)).toEqual([`${OUT}/*`])
  })

  it.each(['"cd" .. && touch x', String.raw`\cd .. && touch x`, String.raw`cd \.\. && touch x`])(
    "reads quoted or escaped cd: %s",
    async (command) => {
      expect(await outside(command)).toEqual(["/work/*"])
    },
  )
  it("asks conservatively when the grammar cannot read a descriptor redirect", async () => {
    expect(await outside(`echo a 3<> ${OUT}/x`)).toEqual(["/*", `${OUT}/*`])
  })
  it("reads an escaped root cd", async () => {
    expect(await outside(String.raw`cd \/ && touch x`)).toEqual(["/*"])
  })
  it("reads bare cd as home", async () => {
    expect(await outside("cd && touch x")).toEqual([path.join(realpathSync(Global.Path.home), "*")])
  })
  it.each([
    "cd sub && cd .. && npm test",
    "cd packages/app && npm test && cd ../..",
    "cd sub | cat; touch x",
    "{ cd sub; }; cd ..; touch x",
    `cd sub && echo a > ../x`,
  ])("keeps project work inside: %s", async (command) => {
    expect(await outside(command)).toEqual([])
  })
  it("resolves each redirect in its own scope and before its cd", async () => {
    expect(await outside("cd sub && cd ../.. && echo a > x")).toEqual(["/work/*"])
    expect(await outside("cd sub && echo a > ../../x")).toEqual(["/work/*"])
    expect(await outside("(cd sub) > ../x")).toEqual(["/work/*"])
    expect(await outside("cd sub > ../x && npm test")).toEqual(["/work/*"])
    expect(await outside("(cd sub); echo a > ../x")).toEqual(["/work/*"])
    expect(await outside("{ cd sub; }; echo a > ../../x")).toEqual(["/work/*"])
  })
  it("does not offer a savable wildcard in a directory path", async () => {
    const resources = await outside("touch '/*/x'")
    expect(resources).toEqual(["/*/*"])
    expect(Permission.tooWideToSave("external_directory", resources[0])).toBe(true)
  })
  it.each([
    "touch $(echo /x)",
    'echo a > "$OUT/x"',
    "python3 write.py",
    `echo 'open("${OUT}/x","w")' | python3`,
    `echo 'touch ${OUT}/x' | sh`,
    `cat > a.sh <<EOF\ntouch ${OUT}/x\nEOF\nsh a.sh`,
  ])("leaves accepted computed-path and script limits alone: %s", async (command) => {
    expect(await outside(command)).toEqual([])
  })
})

describe("round 4: wrapped path flags", () => {
  it.each(["env", "env MODE=test", "command", "command -p", "builtin", "exec", "sudo", "env command"])(
    "checks a curl cluster through %s",
    async (wrapper) => {
      expect(await outside(`${wrapper} curl -sSLo${OUT}/x file://${project}/a.txt`)).toEqual([`${OUT}/*`])
      expect(await outside(`${wrapper} curl -sSLo./src/x file://${project}/a.txt`)).toEqual([])
    },
  )
})

describe("round 4: conditional directories", () => {
  it.each([
    "false && cd sub; echo branch > ../out/x",
    "true || cd sub; echo branch > ../out/x",
    "if false; then cd sub; fi; echo branch > ../out/x",
    "if true; then :; else cd sub; fi; echo branch > ../out/x",
    "if false; then :; elif false; then cd sub; fi; echo branch > ../out/x",
    "while false; do cd sub; done; echo branch > ../out/x",
    "for x; do cd sub; done; echo branch > ../out/x",
    "case x in y) cd sub;; esac; echo branch > ../out/x",
  ])("keeps the directory when a branch can be skipped: %s", async (command) => {
    expect(await outside(command)).toEqual(["/work/out/*"])
  })

  it("checks both the skipped and taken directories", async () => {
    expect(await outside("test flag && cd sub; echo a > ../../out/x")).toEqual(["/out/*", "/work/out/*"])
    expect(await outside("if test flag; then cd one; else cd two/deep; fi; echo a > ../../out/x")).toEqual([
      "/work/out/*",
    ])
  })

  it.each([
    "test flag && cd sub; echo a > local.txt",
    "if test flag; then cd sub; fi; echo a > local.txt",
    "if test flag; then cd one; else cd two; fi; echo a > local.txt",
    "cd sub && cd .. && npm test",
  ])("keeps ordinary project writes quiet: %s", async (command) => {
    expect(await outside(command)).toEqual([])
  })
})

describe("round 4: literal paths through symlinks", () => {
  it("checks existing targets and new files through the longest existing prefix", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "outside-symlink-")))
    const project = path.join(root, "project")
    const out = path.join(root, "out")
    try {
      mkdirSync(project)
      mkdirSync(out)
      mkdirSync(path.join(project, "inside"))
      writeFileSync(path.join(out, "exists.txt"), "outside")
      symlinkSync(out, path.join(project, "outside-link"))
      symlinkSync(path.join(project, "inside"), path.join(project, "inside-link"))
      symlinkSync(path.join(out, "exists.txt"), path.join(project, "file-link"))
      symlinkSync(project, path.join(root, "project-alias"))
      for (const command of [
        "touch outside-link/new.txt",
        "echo outside > outside-link/redirect.txt",
        `touch ${project}/outside-link/absolute.txt`,
        "touch outside-link/exists.txt",
        "touch file-link",
        "curl -sSLooutside-link/new.txt u",
        "env curl -sSLooutside-link/new.txt u",
      ])
        expect(await shellOutsideDirectories(command, project, [project])).toEqual([path.join(out, "*")])
      expect(await shellOutsideDirectories("touch outside-link/../sibling.txt", project, [project])).toEqual([
        path.join(root, "*"),
      ])
      expect(await shellOutsideDirectories("touch outside-link/new/deep/file.txt", project, [project])).toEqual([
        path.join(out, "new/deep/*"),
      ])
      for (const command of ["touch inside/new.txt", "touch inside-link/new.txt", "echo a > inside-link/new.txt"])
        expect(await shellOutsideDirectories(command, project, [project])).toEqual([])
      const alias = path.join(root, "project-alias")
      expect(await shellOutsideDirectories("touch inside/new.txt", alias, [alias])).toEqual([])
      for (const command of ["touch /tmp/r09/new.txt", "touch /var/tmp/r09/new.txt"]) {
        const resources = await shellOutsideDirectories(command, project, [project])
        expect(isTrusted(resources, [])).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("round 3: the plugin owns one shell permission check", () => {
  it.each([
    { mode: "ask", command: "cd sub && cd .. && npm test", expected: [] },
    {
      mode: "ask",
      command: "touch /tmp/r09/x",
      expected: [{ resources: [path.join(realpathSync("/tmp"), "r09/*")], effect: "allow" }],
    },
    {
      mode: "ask",
      command: "touch /var/tmp/r09/x",
      expected: [{ resources: [path.join(realpathSync("/var/tmp"), "r09/*")], effect: "allow" }],
    },
    { mode: "ask", command: `true && echo a > ${OUT}/x`, expected: [{ resources: [`${OUT}/*`], effect: "ask" }] },
    {
      mode: "ask",
      command: `env curl -sSLo${OUT}/x file://${project}/a.txt`,
      expected: [{ resources: [`${OUT}/*`], effect: "ask" }],
    },
    {
      mode: "ask",
      command: "false && cd sub; echo branch > ../out/x",
      expected: [{ resources: ["/work/out/*"], effect: "ask" }],
    },
    {
      mode: "ask",
      command: "if false; then cd sub; fi; echo branch > ../out/x",
      expected: [{ resources: ["/work/out/*"], effect: "ask" }],
    },
    { mode: "auto", command: `touch ${OUT}/x`, expected: [{ resources: [`${OUT}/*`], effect: "allow" }] },
    { mode: "battle", command: "touch ./inside.txt", expected: [] },
  ])("checks $mode: $command", async ({ mode, command, expected }) => {
    const call: Tool.Context = {
      sessionID: Session.ID.make("ses_scan"),
      agent: Agent.ID.make("build"),
      messageID: SessionMessage.ID.make("msg_scan"),
      id: Tool.CallID.make("call_scan"),
      progress: () => Effect.void,
    }
    const assignments = new AssignmentRegistry()
    if (mode !== "ask")
      assignments.assign(String(call.sessionID), {
        runID: "run",
        rootSessionID: String(call.sessionID),
        scopeID: "scope",
        assignmentID: "assignment",
        telemetry: mode === "battle",
      })
    const checks: Array<{ resources: readonly string[]; effect: string }> = []
    let evaluate!: (event: PermissionEvaluation) => Effect.Effect<void>
    const coreEffects: string[] = []
    const shell: Tool.Info & { id: string } = {
      id: "shell",
      name: "shell",
      description: "Test executor; never spawns a process",
      input: Schema.Unknown,
      execute: () =>
        Effect.gen(function* () {
          const event: PermissionEvaluation = {
            sessionID: call.sessionID,
            action: "external_directory",
            effect: mode === "battle" ? "allow" : "ask",
            resources: ["/work/*"],
            source: { type: "tool", id: call.id, messageID: call.messageID },
          }
          yield* evaluate(event)
          coreEffects.push(event.effect)
          event.effect = "deny"
          yield* evaluate(event)
          coreEffects.push(event.effect)
          return { content: "executed" }
        }),
    }
    const registration = Effect.succeed({ dispose: Effect.void })
    const context = {
      location: { directory: project, project: { directory: project } },
      provider: { transform: () => registration },
      agent: { transform: () => registration },
      aisdk: { hook: () => registration },
      session: {
        hook: () => registration,
        get: () =>
          Effect.succeed({
            id: call.sessionID,
            location: { directory: project },
            permissions: permissionRules([], sandboxForSession(String(call.sessionID), project, "/work/checkout")),
          }),
      },
      event: { subscribe: () => Stream.empty },
      shell: { hook: () => registration },
      skill: { list: () => Effect.succeed({ data: [] }) },
      permission: {
        hook: (_name: string, callback: typeof evaluate) => {
          evaluate = callback
          return registration
        },
        assert: (input: Permission.AssertInput) =>
          Effect.gen(function* () {
            const event: PermissionEvaluation = { ...input, effect: "ask" }
            yield* evaluate(event)
            checks.push({ resources: input.resources, effect: event.effect })
          }),
      },
      tool: {
        hook: () => registration,
        transform: (update: (editor: ToolEditor) => void) =>
          Effect.sync(() => {
            update({
              list: () => [shell],
              get: (id) => (id === "shell" ? shell : undefined),
              update: (id, edit) => {
                if (id === "shell") edit(shell)
              },
              add: () => {},
              remove: () => {},
              namespace: () => {},
            })
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Context
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* createArenaEnginePlugin({ enabled: true, assignments, autoAccept: mode === "auto" }).effect(context)
        expect(yield* shell.execute({ command }, call)).toEqual({ content: "executed" })
        // The duplicate suppression is scoped to this execution, not to the session or later calls.
        const after: PermissionEvaluation = {
          sessionID: call.sessionID,
          action: "external_directory",
          effect: "ask",
          resources: ["/other/*"],
          source: { type: "tool", id: call.id, messageID: call.messageID },
        }
        yield* evaluate(after)
        expect(after.effect).toBe({ ask: "ask", auto: "allow", battle: "deny" }[mode])
      }).pipe(Effect.scoped),
    )
    expect(checks).toEqual(expected)
    expect(coreEffects).toEqual(["allow", "deny"])
  })
})
