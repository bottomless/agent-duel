import { describe, expect, it } from "vitest";
import { createThinkingMarkdownParser } from "./thinking-parser";

function allTokens(markdown: string) {
  const parser = createThinkingMarkdownParser();
  const blockTokens = parser.parse(markdown, {});
  return blockTokens.reduce<typeof blockTokens>((tokens, token) => {
    tokens.push(token);
    tokens.push(...(token.children ?? []));
    return tokens;
  }, []);
}

describe("thinking Markdown parser", () => {
  it("keeps the supported Markdown structures", () => {
    const tokens = allTokens(
      [
        "# Heading",
        "",
        "> Quote",
        "",
        "- parent",
        "  - child",
        "",
        "| A | B |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "Use `inline` and [a link](https://example.com).",
        "",
        "```ts",
        "const value = 1;",
        "```",
      ].join("\n"),
    );
    const types = tokens.map((token) => token.type);

    expect(types).toEqual(
      expect.arrayContaining([
        "heading_open",
        "blockquote_open",
        "bullet_list_open",
        "table_open",
        "code_inline",
        "link_open",
        "fence",
      ]),
    );
  });

  it("keeps complete and incomplete fenced code as code", () => {
    for (const closingFence of ["\n```", ""]) {
      const fence = allTokens(`\`\`\`mermaid\ngraph TD\n  A --> B${closingFence}`).find(
        (token) => token.type === "fence",
      );

      expect(fence).toMatchObject({ info: "mermaid" });
      expect(fence?.content.trimEnd()).toBe("graph TD\n  A --> B");
    }

    expect(() => allTokens("Use `unfinished inline code")).not.toThrow();
  });

  it("does not create image or raw HTML tokens", () => {
    const source = [
      "![remote alt](https://thinking.invalid/pixel.png)",
      '<img src="https://thinking.invalid/raw.png" alt="raw alt">',
      "<script>window.__thinkingInjected = true</script>",
    ].join("\n\n");
    const tokens = allTokens(source);

    expect(tokens.some((token) => token.type === "image")).toBe(false);
    expect(
      tokens.some((token) => token.type === "html_inline" || token.type === "html_block"),
    ).toBe(false);
    expect(tokens.map((token) => token.content).join("\n")).toContain("thinking.invalid");
  });
});
