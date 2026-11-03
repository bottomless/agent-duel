import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { expect, it } from "vitest";
import { FONT_SIZE } from "@/styles/theme";

it("uses the current typography scale for leaderboard text", () => {
  const filename = new URL("./screen.tsx", import.meta.url);
  const source = ts.createSourceFile(
    filename.pathname,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const tokens: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "theme" &&
      node.expression.name.text === "fontSize"
    ) {
      tokens.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  expect(tokens.length).toBeGreaterThan(0);
  for (const token of tokens) {
    expect(FONT_SIZE, `leaderboard fontSize.${token}`).toHaveProperty(token);
  }
});
