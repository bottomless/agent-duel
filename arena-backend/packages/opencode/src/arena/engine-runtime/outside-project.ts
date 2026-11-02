import { realpathSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Language, Parser, type Node } from "web-tree-sitter"
import { lazy } from "@/util/lazy"
import { DIRECTORY as SHELL_OUTPUT } from "@opencode/core/shell"
import { ShellScan } from "@opencode/core/shell/scan"
import { DIRECTORY as TOOL_OUTPUT } from "@opencode/core/tool-output"
import type { Permission } from "@opencode/schema/permission"
import { Global } from "@opencode/util/global"
import type { Types } from "effect"

const ACTION = "external_directory"
const GLOB_SUFFIX = path.sep + "*"

/**
 * "Ask before tools" must ask before a tool leaves the project. OpenCode 2.0 documents `ask` as the
 * built-in default for `external_directory`, but its default agent rules start with `* allow`, which
 * matches it first (upstream #54524). Put the rule back at the agent level, so it reaches chats that
 * already exist and their subagents, and it stays below a user's configured rules and a contestant's
 * sandbox, which comes from the session. Auto Accept answers the request in the daemon.
 */
export function askOutsideProject(rules: Types.DeepMutable<Permission.Ruleset>) {
  // Explore is the one built-in agent that allows it outright, and its shell can write.
  const explicit = rules.findLast((rule) => rule.action === ACTION && rule.resource === "*")
  if (explicit) {
    if (explicit.effect === "allow") explicit.effect = "ask"
    return
  }
  const fallback = rules.findLastIndex((rule) => rule.action === "*" && rule.resource === "*")
  if (fallback < 0 || rules[fallback].effect !== "allow") return
  rules.splice(fallback + 1, 0, { action: ACTION, resource: "*", effect: "ask" })
}

function spellings(directory: string) {
  try {
    return [directory, realpathSync(directory)]
  } catch {
    return [directory]
  }
}

function resolveExistingPrefix(target: string): string {
  const parent = path.dirname(target)
  // fs.realpath normalizes `..` before following links. Resolve its parent first instead.
  if (target.split(path.sep).includes("..")) return path.resolve(resolveExistingPrefix(parent), path.basename(target))
  try {
    return realpathSync(target)
  } catch {
    // A write's leaf (and some parents) may not exist yet, but an ancestor can still be a symlink.
    if (parent === target) return target
    return path.join(resolveExistingPrefix(parent), path.basename(target))
  }
}

function contains(directory: string, target: string) {
  const relative = path.relative(directory, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/**
 * Directories the agent's own work puts files in. It has to open them to read long tool output, a
 * background command's output, a skill, its plan, or an upload the user attached, so they never ask.
 */
function trustedDirectories(skillFiles: readonly string[]) {
  const home = process.env.PASEO_HOME?.trim() || path.join(Global.Path.home, ".paseo")
  return [
    path.join(Global.Path.data, TOOL_OUTPUT),
    path.join(Global.Path.data, SHELL_OUTPUT),
    Global.Path.tmp,
    "/tmp",
    "/var/tmp",
    path.join(Global.Path.home, ".opencode", "plan"),
    path.join(home, "uploads"),
    ...skillFiles.map((file) => path.dirname(file)),
  ].flatMap(spellings)
}

export function isTrusted(resources: readonly string[], skillFiles: readonly string[]) {
  const trusted = trustedDirectories(skillFiles)
  return resources.every((resource) => {
    const directory = resource.endsWith(GLOB_SUFFIX) ? resource.slice(0, -GLOB_SUFFIX.length) : resource
    return trusted.some((root) => contains(root, directory))
  })
}

// Commands that only read their arguments. A redirect on one still counts as a write.
const READS = new Set([
  "[",
  "cat",
  "diff",
  "echo",
  "file",
  "grep",
  "head",
  "ls",
  "printf",
  "pwd",
  "rg",
  "stat",
  "tail",
  "test",
  "wc",
  "which",
])
// Track directory changes before reading the next command in this shell scope.
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const SHELLS = new Set(["bash", "csh", "tcsh", "dash", "eval", "fish", "ksh", "sh", "xargs", "zsh"])
const INTERPRETERS = new Set([
  "bun",
  "deno",
  "lua",
  "node",
  "nodejs",
  "perl",
  "php",
  "python",
  "python2",
  "python3",
  "ruby",
])
// A lone `/` is an operand or a separator to these, not the root directory.
const SLASH_AS_TEXT = new Set(["awk", "bc", "cut", "expr", "tr"])
// Text for humans or for a search. These values name no file.
const TEXT_FLAGS = new Set(["-S", "-G", "-b", "-m", "-t", "--author", "--body", "--grep", "--message", "--title"])
const QUOTED_PATH = /(['"`])((?:~\/|\.\.\/|\/)[^'"`\n]*)\1/g
const TOKEN_BREAK = /[\s=<>(),;|&'"`]+/
const PATH_FLAGS: Record<string, string> = {
  curl: "oDK",
  wget: "OP",
  tar: "CfT",
  install: "t",
  gcc: "o",
  cc: "o",
  clang: "o",
}

function expandHome(word: string) {
  const expanded = word.replace(/\$(?:HOME\b|\{HOME\})/g, Global.Path.home)
  if (expanded === "~") return Global.Path.home
  return expanded.startsWith("~/") ? path.join(Global.Path.home, expanded.slice(2)) : expanded
}

/** An absolute path, a path from home, or one with a `..` segment. A lone `/` is the caller's call. */
function looksOutside(word: string) {
  if (word.startsWith("/") || word === "~" || word.startsWith("~/")) return word !== "/"
  return word.split("/").includes("..")
}

/** The paths in text that a shell or an interpreter will read as code, so words cannot be trusted. */
function codePaths(text: string, slashIsPath: boolean) {
  const found: string[] = []
  const rest = text.replace(QUOTED_PATH, (_match, _quote: string, literal: string) => {
    if (literal !== "/" || slashIsPath) found.push(literal)
    return " "
  })
  for (const token of rest.split(TOKEN_BREAK)) {
    if (looksOutside(token) || (slashIsPath && token === "/")) found.push(token)
  }
  // The end of a string: `os.system('rm -rf /')`.
  if (/\s\/['"`]/.test(rest)) found.push("/")
  return found
}

/** Whether this word is the program of a sed or awk command, and not a file for it to work on. */
function isScript(name: string, words: readonly string[], index: number) {
  if (name !== "sed" && name !== "awk") return false
  if (words.includes("-f") || words.includes("--file")) return false
  if (name === "sed" && words.some((value) => value === "-e" || value === "--expression"))
    return words[index - 1] === "-e" || words[index - 1] === "--expression"
  const valued = name === "awk" ? ["-F", "-v"] : []
  const script = words.findIndex(
    (value, at) => at > 0 && value !== "" && !value.startsWith("-") && !valued.includes(words[at - 1]),
  )
  return index === script
}

/** The paths a sed or awk program can write to. Its patterns are not paths; `w` and `>` targets are. */
function scriptPaths(name: string, script: string) {
  if (name === "awk") return /[>|]|system|getline/.test(script) ? codePaths(script, false) : []
  const commands = script
    .replace(/(^|[;{}\s])s(.)(?:\\.|(?!\2).)*\2(?:\\.|(?!\2).)*\2[gip\d]*/g, "$1")
    .replace(/(^|[;{,])\/(?:\\.|[^/])*\/I?/g, "$1")
    .replace(/(^|[;{,])\/(?:\\.|[^/])*\/I?/g, "$1")
  return /^[\s\d,;$!{}pdqnNgGhHxPD=-]*$/.test(commands) ? [] : codePaths(commands.replace(/\bw(?=\/)/g, "w "), false)
}

/** The parts of a command word that can name a path: `--out=/x`, `-o/x`, `/a:/b`, `a,/b`. */
function wordParts(word: string, name: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return word.toLowerCase().startsWith("file://") ? [word.slice(7)] : []
  // A path-taking short option ends the flag cluster; everything after it is its value.
  let attached = /^-[A-Za-z](.+)$/.exec(word)?.[1]
  if (word.startsWith("-") && !word.startsWith("--") && PATH_FLAGS[name]) {
    const at = [...word.slice(1)].findIndex((letter) => PATH_FLAGS[name].includes(letter))
    if (at >= 0) attached = word.slice(at + 2)
  }
  const pieces = word.search(/[=,:]/) < 0 ? [] : word.split(/[=,:]/)
  return [word, ...(attached ? [attached] : []), ...pieces]
}

function executableWords(words: readonly string[]): readonly string[] {
  const name = path.basename(words[0] ?? "")
  if (!["sudo", "env", "command", "builtin", "exec"].includes(name)) return words
  const valued: Record<string, readonly string[]> = {
    sudo: ["-u", "-g", "-h", "-p", "-C", "-T", "--user", "--group", "--host", "--prompt"],
    env: ["-u", "-C", "--unset", "--chdir"],
    exec: ["-a"],
  }
  let index = 1
  for (; index < words.length; index++) {
    const word = words[index]
    if (word === "--") {
      index++
      break
    }
    if (valued[name]?.includes(word)) {
      index++
      continue
    }
    if (word.startsWith("-") || /^[A-Za-z_][A-Za-z_0-9]*=/.test(word)) continue
    break
  }
  return executableWords(words.slice(index))
}

function wordPaths(input: readonly string[]) {
  const words = executableWords(input)
  const name = path.basename(words[0] ?? "")
  const found: string[] = []
  for (let index = 1; index < words.length; index++) {
    const word = words[index]
    if (name === "git" || name === "gh") {
      const flag = word.startsWith("--") ? word.split("=")[0] : word.slice(0, 2)
      if (TEXT_FLAGS.has(flag) && word.length > flag.length) continue
      if (TEXT_FLAGS.has(words[index - 1])) continue
    }
    if (name === "sed" && /^(?:-e|--expression=).+/.test(word)) {
      found.push(...scriptPaths(name, word.replace(/^(?:-e|--expression=)/, "")))
      continue
    }
    if (isScript(name, words, index)) {
      found.push(...scriptPaths(name, word))
      continue
    }
    for (const part of wordParts(word, name)) {
      if (part === "/" && SLASH_AS_TEXT.has(name)) continue
      if (!part.startsWith("-")) found.push(part)
    }
  }
  return found
}

const parser = lazy(async () => {
  const { default: runtime } = await import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } })
  const resolve = (asset: string) => fileURLToPath(new URL(asset, import.meta.url))
  await Parser.init({ locateFile: () => resolve(runtime) })
  const { default: grammar } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const instance = new Parser()
  instance.setLanguage(await Language.load(resolve(grammar)))
  return instance
})

// Expand literal brace alternatives without executing shell code. Quoted braces stay literal.
function alternatives(raw: string, budget = 64): string[] | undefined {
  if (budget <= 0) return undefined
  let quote = ""
  let start = -1
  let depth = 0
  const cuts: number[] = []
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (char === "\\" && quote !== "'") {
      index++
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "{") {
      if (depth++ === 0) start = index
      continue
    }
    if (char === "," && depth === 1) cuts.push(index)
    if (char !== "}" || depth === 0 || --depth !== 0) continue
    if (!cuts.length) continue
    const bounds = [start, ...cuts, index]
    const result: string[] = []
    for (let at = 1; at < bounds.length; at++) {
      const next = alternatives(
        raw.slice(0, start) + raw.slice(bounds[at - 1] + 1, bounds[at]) + raw.slice(index + 1),
        budget - result.length - 1,
      )
      if (!next) return undefined
      result.push(...next)
    }
    return result
  }
  return [raw]
}

function literalWords(raw: string): string[] | undefined {
  const expanded = alternatives(raw)
  if (!expanded) return undefined
  const words: string[] = []
  for (const text of expanded) {
    const scan = ShellScan.scan(`echo ${text}`, "bash")
    if (scan.kind !== "scanned" || scan.commands[0]?.words.length !== 2) return undefined
    words.push(scan.commands[0].words[1])
  }
  return words
}

interface DirectoryFlow {
  success: string[]
  failure: string[]
}

function after(flow: DirectoryFlow) {
  return [...new Set([...flow.failure, ...flow.success])]
}

/** Walk shell scopes and redirects, without running code or resolving computed path values. */
export async function shellPaths(command: string, cwd: string) {
  const tree = (await parser()).parse(command + "\n")
  if (!tree) return ["/"]
  const paths = new Set<string>([cwd + "/"])
  const add = (word: string, base: string, directory = false) => {
    const expanded = expandHome(word)
    // Variables and computed path values are intentionally outside this policy.
    if (expanded.includes("$") || expanded.includes("`")) return
    const resolved = resolveExistingPrefix(path.isAbsolute(expanded) ? expanded : `${base}/${expanded}`)
    paths.add((directory || expanded.endsWith("/")) && resolved !== "/" ? resolved + "/" : resolved)
  }
  const unreadable = () => paths.add("/")
  const read = (node: Node) => {
    const words = literalWords(node.text)
    if (!words) unreadable()
    return words ?? []
  }
  const redirects = (nodes: readonly Node[], base: string) => {
    for (const node of nodes) {
      const operator = node.children.find((child) => child && /^(?:[&]?>>?|>\||>&|<>)$/.test(child.text))?.text
      if (!operator) continue
      const targets = node.childrenForFieldName("destination").filter((child): child is Node => child !== null)
      if (!targets.length) {
        unreadable()
        continue
      }
      for (const target of targets) {
        if (operator === ">&" && /^(?:\d+|-)$/.test(target.text)) continue
        for (const word of read(target)) add(word, base)
      }
    }
  }
  const sequence = (
    nodes: readonly Node[],
    initial: readonly string[],
    trailing: readonly Node[] = [],
  ): DirectoryFlow => {
    let flow: DirectoryFlow = { success: [...initial], failure: [...initial] }
    for (let index = 0; index < nodes.length; index++)
      flow = walk(nodes[index], after(flow), index === nodes.length - 1 ? trailing : [])
    return flow
  }
  const walk = (node: Node, initial: readonly string[], trailing: readonly Node[] = []): DirectoryFlow => {
    const unchanged = { success: [...initial], failure: [...initial] }
    const children = node.namedChildren.filter((child): child is Node => child !== null)
    const own = children.flatMap((child) => {
      if (child.type === "file_redirect") return [child]
      return child.type === "heredoc_redirect"
        ? child.descendantsOfType("file_redirect").filter((node): node is Node => node !== null)
        : []
    })
    if (node.type === "redirected_statement") {
      const body = node.childForFieldName("body")
      if (!body) {
        unreadable()
        return unchanged
      }
      return walk(body, initial, [...own, ...trailing])
    }
    if (node.type === "list") {
      const left = children[0]
      const right = children[1]
      if (!left || !right) return sequence(children, initial, trailing)
      const operator = node.children.find((child) => child?.text === "&&" || child?.text === "||")?.text
      const first = walk(left, initial)
      const next = operator === "||" ? first.failure : first.success
      const last = walk(right, next, trailing)
      // Only the executed side of &&/|| feeds the next command in that chain. Both exits feed `;`.
      if (operator === "&&")
        return { success: last.success, failure: [...new Set([...first.failure, ...last.failure])] }
      if (operator === "||")
        return { success: [...new Set([...first.success, ...last.success])], failure: last.failure }
      return sequence(children, initial, trailing)
    }
    if (node.type === "program") return sequence(children, initial, trailing)
    if (node.type === "pipeline") {
      for (let index = 0; index < children.length; index++)
        walk(children[index], initial, index === children.length - 1 ? trailing : [])
      return unchanged
    }
    for (const base of initial) redirects([...own, ...trailing], base)
    if (node.type === "if_statement" || node.type === "elif_clause") {
      const success: string[] = []
      const failure: string[] = []
      let remaining = [...initial]
      const clauses = [node, ...children.filter((child) => child.type === "elif_clause")]
      for (const clause of clauses) {
        const then = clause.children.find((child) => child?.text === "then")
        if (!then) {
          unreadable()
          return unchanged
        }
        const nodes = clause.namedChildren.filter((child): child is Node => child !== null)
        const condition = nodes.filter((child) => child.endIndex <= then.startIndex)
        const flow = sequence(condition, remaining)
        const body = nodes.filter(
          (child) => child.startIndex >= then.endIndex && child.type !== "elif_clause" && child.type !== "else_clause",
        )
        const taken = sequence(body, flow.success)
        success.push(...taken.success)
        failure.push(...taken.failure)
        remaining = flow.failure
      }
      const otherwise = children.find((child) => child.type === "else_clause")
      if (otherwise) {
        const flow = walk(otherwise, remaining)
        success.push(...flow.success)
        failure.push(...flow.failure)
        remaining = []
      }
      return { success: [...new Set([...success, ...remaining])], failure: [...new Set(failure)] }
    }
    if (node.type === "case_statement") {
      const outcomes = children
        .filter((child) => child.type === "case_item")
        .flatMap((child) => after(walk(child, initial)))
      const bases = [...new Set([...initial, ...outcomes])]
      return { success: bases, failure: bases }
    }
    if (["while_statement", "for_statement", "c_style_for_statement"].includes(node.type)) {
      const flow = sequence(children, initial)
      const bases = [...new Set([...initial, ...after(flow)])]
      return { success: bases, failure: bases }
    }
    if (node.type === "command") {
      const nameNode = node.childForFieldName("name")
      const args = node.childrenForFieldName("argument").filter((child): child is Node => child !== null)
      const names = nameNode ? read(nameNode) : []
      const name = path.basename(names[0] ?? "")
      const words = [name, ...args.flatMap(read)]
      let flow = unchanged
      if (CWD.has(name)) {
        const targets = words.slice(1).filter((word) => !word.startsWith("-"))
        const target = targets[0] ?? Global.Path.home
        if (!/[$`]/.test(target)) {
          const bases = initial.map((base) => path.resolve(base, expandHome(target)))
          for (const base of bases) add(base, base, true)
          flow = { success: [...new Set(bases)], failure: [] }
        }
      } else {
        if (!READS.has(name)) for (const word of wordPaths(words)) for (const base of initial) add(word, base)
        const wrapped = ["sudo", "env", "command", "builtin", "exec"].includes(name)
        let shellIndex = -1
        if (SHELLS.has(name)) shellIndex = 0
        else if (wrapped) shellIndex = words.findIndex((word) => SHELLS.has(path.basename(word)))
        if (shellIndex >= 0) {
          const flag = words.findIndex((word, index) => index > shellIndex && /^-[A-Za-z]*c/.test(word))
          let code: string | undefined
          if (name === "eval") code = words.slice(1).join(" ")
          else if (flag >= 0) code = words[flag + 1]
          if (code) for (const base of initial) scanCode(code, base)
        } else if (INTERPRETERS.has(name)) {
          for (const word of codePaths(args.map((arg) => arg.text).join(" "), false))
            for (const base of initial) add(word, base)
        }
      }
      // A substitution has its own cd state; its output remains a computed path.
      for (const child of node.descendantsOfType(["command_substitution", "process_substitution"]))
        if (child) walk(child, initial)
      return flow
    }
    if (
      [
        "string",
        "raw_string",
        "ansi_c_string",
        "word",
        "concatenation",
        "comment",
        "heredoc_body",
        "heredoc_redirect",
        "file_redirect",
      ].includes(node.type)
    )
      return unchanged
    const flow = sequence(
      children.filter((child) => child.type !== "file_redirect"),
      initial,
    )
    return node.type === "subshell" || node.type === "command_substitution" || node.type === "process_substitution"
      ? unchanged
      : flow
  }
  const scanCode = (text: string, base: string) => {
    const nested = parserInstance.parse(text + "\n")
    if (!nested) {
      unreadable()
      return
    }
    try {
      if (nested.rootNode.hasError) unreadable()
      walk(nested.rootNode, [base])
    } finally {
      nested.delete()
    }
  }
  const parserInstance = await parser()
  try {
    if (tree.rootNode.hasError) {
      unreadable()
      for (const word of codePaths(command, true)) add(word, cwd)
    }
    walk(tree.rootNode, [cwd])
    return [...paths]
  } finally {
    tree.delete()
  }
}

export async function shellOutsideDirectories(command: string, cwd: string, project: readonly string[]) {
  const roots = project.map(resolveExistingPrefix)
  const directories = (await shellPaths(command, cwd))
    .map((target) => {
      const resolved = resolveExistingPrefix(target)
      return target.endsWith("/") && resolved !== "/" ? resolved + "/" : resolved
    })
    .filter((target) => !target.startsWith("/dev/") && !roots.some((root) => contains(root, target)))
    .map((target) => {
      if (target.length > 1 && target.endsWith("/")) return target.slice(0, -1)
      return statSync(target, { throwIfNoEntry: false })?.isDirectory() ? target : path.dirname(target)
    })
  return [...new Set(directories)].map((directory) => path.join(directory, "*"))
}

export * as ArenaOutsideProject from "./outside-project.js"
