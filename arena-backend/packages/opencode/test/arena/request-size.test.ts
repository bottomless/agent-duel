import { describe, expect, test } from "bun:test"
import { Media, Message, ToolCallPart, ToolResultPart } from "@opencode/ai"
import { REQUEST_BYTES_TRIGGER, boundRequestSize } from "@/arena/engine-runtime/request-size"

const system = [{ type: "text" as const, text: "You are a contestant." }]
let call = 0

/** A base64 payload of `megabytes` million bytes once encoded; `version` changes its content. */
const payload = (megabytes: number, version = "A") => version.repeat(Math.round(megabytes * 1_000_000))

/** One model step that reads each named image, then the tool results the next request carries. */
function step(images: ReadonlyArray<readonly [name: string, megabytes: number, version?: string]>) {
  const calls = images.map(([name]) => ({ id: `call_${++call}`, name }))
  return [
    Message.assistant(calls.map(({ id, name }) => ToolCallPart.make({ id, name: "read", input: { path: name } }))),
    ...images.map(([name, megabytes, version], index) =>
      Message.tool(
        ToolResultPart.make({
          id: calls[index].id,
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: `data:image/jpeg;base64,${payload(megabytes, version)}`, mime: "image/jpeg", name },
            ],
          },
        }),
      ),
    ),
  ]
}

const user = (text: string, images: ReadonlyArray<readonly [name: string, megabytes: number]> = []) =>
  Message.user([
    Message.text(text),
    ...images.map(([name, megabytes]) =>
      Message.media(Media.base64(payload(megabytes), "image/png"), { filename: name }),
    ),
  ])

const answer = (text: string) => Message.assistant([Message.text(text)])

const NOTE =
  /^\[Image (\S+) (was removed|was not attached: the images|was not attached: it is|was not attached: it was)/
const KINDS: Record<string, string> = {
  "was removed": "removed",
  "was not attached: the images": "deferred",
  "was not attached: it is": "oversized",
  "was not attached: it was": "exhausted",
}

/** What the request shows the model for each image: `sent`, or the kind of note in its place. */
function shown(messages: readonly Message[]) {
  const result: Record<string, string> = {}
  const record = (text: string) => {
    const match = text.match(NOTE)
    if (match) result[match[1]] = KINDS[match[2]]
  }
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "media" && part.filename) result[part.filename] = "sent"
      if (part.type === "text") record(part.text)
      if (part.type !== "tool-result" || part.result.type !== "content") continue
      for (const item of part.result.value) {
        if (item.type === "file" && item.name) result[item.name] = "sent"
        if (item.type === "text") record(item.text)
      }
    }
  }
  return result
}

const bound = (messages: readonly Message[]) => boundRequestSize({ system, tools: {}, messages })

describe("request size", () => {
  test("a request under the limit is left alone", () => {
    const messages = [
      user("Check these slides"),
      ...step([
        ["slide-1.jpg", 0.2],
        ["slide-2.jpg", 0.2],
      ]),
    ]
    expect(bound(messages).report).toBeUndefined()
  })

  test("the oldest images go first, down to the target, and the newest step stays", () => {
    // Like Qwen's battle: renders read one per step pile up until the body passes the trigger.
    const messages = [
      user("Review the deck"),
      ...Array.from({ length: 30 }, (_, index) => step([[`render-${index + 1}.jpg`, 0.15]])).flat(),
    ]
    const { messages: sent, report } = bound(messages)
    const view = shown(sent)
    expect(view["render-30.jpg"]).toBe("sent")
    expect(report?.after).toBeLessThanOrEqual(REQUEST_BYTES_TRIGGER)
    const removed = Object.keys(view).filter((name) => view[name] === "removed")
    expect(removed.length).toBeGreaterThan(0)
    expect(removed).toEqual(removed.map((_, index) => `render-${index + 1}.jpg`))
  })

  test("a request keeps the earlier requests' decisions, so the cached prefix survives", () => {
    const history = [
      user("Review the deck"),
      ...Array.from({ length: 30 }, (_, index) => step([[`render-${index + 1}.jpg`, 0.15]])).flat(),
    ]
    const first = shown(bound(history).messages)
    // Two more small renders fit in the room the last removal made: nothing else moves.
    const later = shown(
      bound([...history, ...step([["render-31.jpg", 0.15]]), ...step([["render-32.jpg", 0.15]])]).messages,
    )
    for (const [name, state] of Object.entries(first)) expect(later[name]).toBe(state)
    expect(later["render-32.jpg"]).toBe("sent")
  })

  test("a step whose images do not fit together sends the first ones and defers the rest", () => {
    // Like Kimi's battle: five slides read at once, 7 MB together.
    const slides = [
      ["slide-1.png", 1.2],
      ["slide-2.png", 1.3],
      ["slide-3.png", 1.8],
      ["slide-4.png", 1.4],
      ["slide-5.png", 1.5],
    ] as const
    const first = [user("QA the slides"), ...step(slides)]
    expect(shown(bound(first).messages)).toEqual({
      "slide-1.png": "sent",
      "slide-2.png": "sent",
      "slide-3.png": "deferred",
      "slide-4.png": "deferred",
      "slide-5.png": "deferred",
    })

    // Reading the deferred ones again makes room by removing the previous step's images.
    const second = [...first, ...step([slides[2], slides[3], slides[4]])]
    const { messages: secondSent, report } = bound(second)
    expect(report?.after).toBeLessThanOrEqual(REQUEST_BYTES_TRIGGER)
    const secondTools = secondSent.slice(first.length)
    expect(shown(secondTools)).toEqual({ "slide-3.png": "sent", "slide-4.png": "sent", "slide-5.png": "deferred" })
    expect(shown(secondSent.slice(0, first.length))["slide-1.png"]).toBe("removed")

    // The last one alone fits after the step before it leaves.
    const third = bound([...second, ...step([slides[4]])]).messages
    expect(shown(third.slice(second.length))).toEqual({ "slide-5.png": "sent" })
  })

  test("an image too large to fit alone gets a note asking for a smaller file, and stays out", () => {
    const messages = [user("Look at the poster"), ...step([["poster.png", 4.2]])]
    const sent = bound(messages).messages
    const note = JSON.stringify(sent.at(-1))
    expect(shown(sent)).toEqual({ "poster.png": "oversized" })
    expect(note).toContain("it is 4.2 MB encoded")
    expect(note).toContain("Crop it or export it at a lower resolution")
    // It never comes back on a later request, which would reorder the prefix.
    expect(shown(bound([...messages, answer("I could not see it.")]).messages)).toEqual({ "poster.png": "oversized" })
  })

  test("the user's pasted images are removed only after the images tools read", () => {
    const messages = [
      user("Match this design", [
        ["attachment-1.png", 0.5],
        ["attachment-2.png", 0.5],
      ]),
      ...Array.from({ length: 20 }, (_, index) => step([[`render-${index + 1}.jpg`, 0.2]])).flat(),
    ]
    const view = shown(bound(messages).messages)
    expect(view["attachment-1.png"]).toBe("sent")
    expect(view["attachment-2.png"]).toBe("sent")
    expect(view["render-1.jpg"]).toBe("removed")
  })

  test("a removed pasted image asks the user, a removed tool image asks for a new read", () => {
    const messages = [
      user("Match this design", [["attachment-1.png", 1.4]]),
      ...step([["render-1.jpg", 1.3]]),
      answer("Done."),
      user("Now this one", [["attachment-2.png", 1.4]]),
      ...step([["render-2.jpg", 1.3]]),
    ]
    const text = JSON.stringify(bound(messages).messages)
    expect(text).toContain("Image render-1.jpg was removed")
    expect(text).toContain("Use what you wrote down about it. If you need to see it again, read the file again")
    expect(text).toContain("Image attachment-1.png was removed")
    expect(text).toContain("ask the user to attach it again")
  })

  test("an agent re-reading images in a loop stops getting them back", () => {
    // Like DeepSeek in QA: it needs all five slides, keeps no notes, and reads them one at a time forever.
    const slides = [1.2, 1.3, 1.8, 1.4, 1.5].map((megabytes, index) => [`slide-${index + 1}.png`, megabytes] as const)
    let messages: Message[] = [user("QA the slides")]
    let attachedReads = 0
    for (let round = 0; round < 10; round++)
      for (const slide of slides) {
        messages = [...messages, ...step([slide])]
        if (shown(bound(messages).messages.slice(-1))[slide[0]] === "sent") attachedReads++
      }
    // Each file comes back at most twice after its first read, so attached reads stop growing.
    expect(attachedReads).toBeLessThanOrEqual(slides.length * 3)
    const last = bound([...messages, ...step([slides[0]])])
    expect(shown(last.messages.slice(-1))).toEqual({ "slide-1.png": "exhausted" })
    expect(JSON.stringify(last.messages.at(-1))).toContain("Work from what you wrote down about it")
  })

  test("a new render written to the same path is still attached", () => {
    // His agents rendered every version of a slide to the same file.
    let messages: Message[] = [user("Fix the slides until they look right")]
    const versions = ["A", "B", "C", "D", "E", "F", "G", "H"]
    for (const version of versions)
      for (const index of [1, 2, 3]) messages = [...messages, ...step([[`slide-${index}.png`, 0.9, version]])]
    const last = shown(bound([...messages, ...step([["slide-1.png", 0.9, "Z"]])]).messages.slice(-1))
    expect(last).toEqual({ "slide-1.png": "sent" })
  })

  test("the history itself is never changed", () => {
    const messages = [user("Review the deck"), ...step([["poster.png", 4.2]])]
    const before = JSON.stringify(messages)
    bound(messages)
    expect(JSON.stringify(messages)).toBe(before)
  })
})
