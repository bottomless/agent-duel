import { describe, expect, test } from "bun:test"
import { visibleLogprobs } from "./logprobs"

const bytes = (text: string) => [...new TextEncoder().encode(text)]
const lp = (token: string, extra: { bytes?: number[] } = {}) => ({ token, logprob: -0.1, ...extra })

function stream(chunks: { content?: string; reasoning?: string; tokens?: ReturnType<typeof lp>[] }[]) {
  return [
    ...chunks.map(
      (chunk) =>
        `data: ${JSON.stringify({
          id: "gen-real",
          choices: [
            {
              index: 0,
              delta: { content: chunk.content ?? "", ...(chunk.reasoning ? { reasoning: chunk.reasoning } : {}) },
              ...(chunk.tokens ? { logprobs: { content: chunk.tokens } } : {}),
            },
          ],
        })}\n\n`,
    ),
    "data: [DONE]\n\n",
  ].join("")
}

describe("visibleLogprobs", () => {
  test("keeps every token when they spell the text, as Kimi sends them", () => {
    const body = stream([
      { content: "All tests", tokens: [lp("All"), lp(" tests")] },
      { content: " pass.", tokens: [lp(" pass"), lp(".")] },
    ])
    expect(visibleLogprobs(body)).toEqual({
      text: "All tests pass.",
      tokens: [lp("All"), lp(" tests"), lp(" pass"), lp(".")],
      complete: true,
    })
  })

  test("drops the reasoning tail and the end token, and ignores which chunk carried each token", () => {
    // Captured from Qwen 4 Max: the first text chunk carries the reasoning's last tokens.
    const body = stream([
      { reasoning: "Done", content: "" },
      { content: "calc.py", tokens: [lp(" and"), lp(" improvement"), lp('".'), lp("</think>")] },
      { content: " explanation", tokens: [lp("calc"), lp(".py"), lp(" explanation")] },
      { content: "", tokens: [lp("<|im_end|>")] },
    ])
    const result = visibleLogprobs(body)!
    expect(result.tokens.map((token) => token.token)).toEqual(["calc", ".py", " explanation"])
    expect(result.complete).toBe(true)
  })

  test("stops before the tool call that follows the text, as DeepSeek sends it", () => {
    // Captured from DeepSeek V4.1 Flash: the text drops the line breaks that end its last token.
    const body = stream([
      { content: "I'll read", tokens: [lp("I"), lp("'ll"), lp(" read")] },
      {
        content: " file first.",
        tokens: [lp(" file"), lp(" first"), lp(".\n\n"), lp("<"), lp("｜DSML｜"), lp(" calls")],
      },
    ])
    const result = visibleLogprobs(body)!
    expect(result.tokens.map((token) => token.token)).toEqual(["I", "'ll", " read", " file", " first", ".\n\n"])
    expect(result.complete).toBe(true)
  })

  test("matches a character split across tokens by its bytes", () => {
    const dash = bytes("—")
    const body = stream([
      {
        content: "a — b",
        tokens: [lp("a "), lp("�", { bytes: dash.slice(0, 2) }), lp("�", { bytes: dash.slice(2) }), lp(" b")],
      },
    ])
    const result = visibleLogprobs(body)!
    expect(result.tokens).toHaveLength(4)
    expect(result.complete).toBe(true)
  })

  test("reads an unstreamed response", () => {
    const body = JSON.stringify({
      choices: [{ index: 0, message: { content: "OK" }, logprobs: { content: [lp("OK"), lp("<|im_end|>")] } }],
    })
    expect(visibleLogprobs(body)).toEqual({ text: "OK", tokens: [lp("OK")], complete: true })
  })

  test("marks the result incomplete when the provider stopped sending logprobs", () => {
    const body = stream([
      { content: "One", tokens: [lp("One")] },
      { content: " two", tokens: [] },
    ])
    expect(visibleLogprobs(body)).toEqual({ text: "One two", tokens: [lp("One")], complete: false })
  })

  test("returns nothing for a response without logprobs, so it counts as missing", () => {
    expect(visibleLogprobs(stream([{ content: "Hello" }]))).toBeUndefined()
    expect(
      visibleLogprobs(JSON.stringify({ choices: [{ message: { content: "Hi" }, logprobs: null }] })),
    ).toBeUndefined()
  })
})
