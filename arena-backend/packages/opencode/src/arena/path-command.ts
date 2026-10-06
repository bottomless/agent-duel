import { Language, Parser, type Node } from "web-tree-sitter"
import { fileURLToPath } from "node:url"
import { lazy } from "@/util/lazy"

const parser = lazy(async () => {
  const { default: runtime } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const resolve = (asset: string) => fileURLToPath(new URL(asset, import.meta.url))
  await Parser.init({ locateFile: () => resolve(runtime) })
  const { default: grammar } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const instance = new Parser()
  instance.setLanguage(await Language.load(resolve(grammar)))
  return instance
})

// Decode literal shell words only. Expansions, globs and here-documents remain shell-owned.
function literal(node: Node | null): string | undefined {
  if (!node) return undefined
  if (node.type === "command_name") return node.firstNamedChild ? literal(node.firstNamedChild) : undefined
  if (node.type === "raw_string") return node.text.slice(1, -1)
  if (node.type === "string") {
    if (node.namedChildren.some((child) => child?.type !== "string_content")) return undefined
    return node.text
      .slice(1, -1)
      .replace(/\\([$`"\\\n])/g, (_match, character: string) => (character === "\n" ? "" : character))
  }
  if (node.type === "concatenation") {
    const parts = node.namedChildren.map(literal)
    return parts.every((part) => part !== undefined) ? parts.join("") : undefined
  }
  if (node.type !== "word" || node.namedChildCount > 0) return undefined
  let result = ""
  for (let index = 0; index < node.text.length; index++) {
    const character = node.text[index]
    if (character === "\\") {
      const next = node.text[++index]
      if (next === undefined) return undefined
      if (next !== "\n") result += next
    } else {
      if ("$`*?[{}~".includes(character)) return undefined
      result += character
    }
  }
  return result
}

function quote(value: string, node: Node) {
  if (node.type === "string") return `"${value.replace(/[\\"$`]/g, (character) => `\\${character}`)}"`
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function rewritePathCommand(
  command: string,
  rewritePath: (path: string) => string,
  outputSnippet = false,
): Promise<string> {
  if (outputSnippet && !/^\s*cd(?:\s|$)/.test(command)) return command
  const tree = (await parser()).parse(command + "\n")
  if (!tree) return command
  try {
    if (tree.rootNode.hasError) return command
    // Only an entire `cd <literal> [&& pwd]` line is an executable path example in output.
    // Prose, arbitrary programs and multi-line logs are not command input.
    if (outputSnippet) {
      const top = tree.rootNode.namedChildren
      const nodes = top.length === 1 && top[0]?.type === "list" ? top[0].namedChildren : top
      const first = nodes[0]
      const args = first?.childrenForFieldName("argument") ?? []
      if (
        nodes.length < 1 ||
        nodes.length > 2 ||
        first?.type !== "command" ||
        first.childForFieldName("name")?.text !== "cd" ||
        args.length !== 1 ||
        literal(args[0] ?? null) === undefined ||
        (nodes.length === 2 &&
          (nodes[1]?.text !== "pwd" || command.slice(first.endIndex, nodes[1].startIndex).trim() !== "&&")) ||
        /[\r\n]/.test(command.replace(/\r?\n$/, ""))
      )
        return command
    }
    const edits: { start: number; end: number; value: string }[] = []
    const escapedSpace = (text: string) =>
      text.replace(/\\([\n\t ])/g, (_match, character: string) => (character === "\n" ? "" : character))
    const replace = (nodes: readonly (Node | null)[]) => {
      const node = nodes[0]
      const last = nodes.at(-1)
      if (!node || !last) return
      const parts = nodes.map(literal)
      if (parts.some((part) => part === undefined)) return
      // The grammar splits at some escaped whitespace. Bash keeps those fragments in one word.
      const trailing = /^(?:\\[\n\t ])+/.exec(command.slice(last.endIndex))?.[0] ?? ""
      const end = last.endIndex + trailing.length
      if (trailing && command[end] && !/[\s;|&<>()]/.test(command[end])) return
      const path =
        parts
          .map((part, index) => {
            const previous = nodes[index - 1]
            const node = nodes[index]
            return (previous && node ? escapedSpace(command.slice(previous.endIndex, node.startIndex)) : "") + part
          })
          .join("") + escapedSpace(trailing)
      const mapped = rewritePath(path)
      if (mapped !== path) edits.push({ start: node.startIndex, end, value: quote(mapped, node) })
    }
    const words = (nodes: readonly (Node | null)[]) => {
      let group: Node[] = []
      for (const node of nodes) {
        if (!node) continue
        const last = group.at(-1)
        if (last && !/^(?:\\[\n\t ])+$/.test(command.slice(last.endIndex, node.startIndex))) {
          replace(group)
          group = []
        }
        group.push(node)
      }
      replace(group)
    }
    const visit = (node: Node | null) => {
      if (!node) return
      if (node.type === "command") {
        const name = node.childForFieldName("name")
        const args = node.childrenForFieldName("argument")
        words([name, ...args])
        for (const child of node.namedChildren) {
          if (child?.type === "variable_assignment" || child?.type === "file_redirect") visit(child)
        }
        return
      }
      if (node.type === "variable_assignment" || node.type === "file_redirect") {
        const field = node.type === "variable_assignment" ? "value" : "destination"
        words(node.childrenForFieldName(field))
        return
      }
      if (["string", "raw_string", "concatenation", "heredoc_redirect", "heredoc_body", "comment"].includes(node.type))
        return
      for (const child of node.namedChildren) visit(child)
    }
    visit(tree.rootNode)
    return edits
      .sort((left, right) => right.start - left.start)
      .reduce((text, edit) => text.slice(0, edit.start) + edit.value + text.slice(edit.end), command)
  } finally {
    tree.delete()
  }
}
