import MarkdownIt from "markdown-it";

export function createThinkingMarkdownParser() {
  const parser = MarkdownIt({ typographer: true, linkify: true });

  parser.inline.ruler.disable("image");

  return parser;
}

export const thinkingMarkdownParser = createThinkingMarkdownParser();
