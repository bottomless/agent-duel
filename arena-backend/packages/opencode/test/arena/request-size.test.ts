import { describe, expect, test } from "bun:test"
import { Media, Message, ToolCallPart, ToolResultPart } from "@opencode/ai"
import {
  IMAGE_ROOM_KEPT,
  REQUEST_BYTES_LIMIT,
  UPSTREAM_IMAGES,
  UPSTREAM_MEDIA_BYTES,
  boundRequestSize,
  type MediaCarriage,
} from "@/arena/engine-runtime/request-size"

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

const bound = (messages: readonly Message[], carriage: MediaCarriage = "reference") =>
  boundRequestSize({ system, tools: {}, messages }, carriage)

const renders = (count: number, megabytes: number, from = 1) =>
  Array.from({ length: count }, (_, index) => step([[`render-${from + index}.jpg`, megabytes]])).flat()

const sentNames = (view: Record<string, string>) => Object.keys(view).filter((name) => view[name] === "sent")

describe("request size", () => {
  test("a request under the limits is left alone", () => {
    const messages = [
      user("Check these slides"),
      ...step([
        ["slide-1.jpg", 0.2],
        ["slide-2.jpg", 0.2],
      ]),
    ]
    expect(bound(messages).report).toBeUndefined()
  })

  test("images and PDFs an upload can carry do not count against the hosted body limit", () => {
    // 3.3 MB of text, a 3 MB PDF and 4.5 MB of renders: only references go to the control plane.
    const messages = [
      Message.user([Message.text("Read the spec"), Message.media(Media.base64(payload(3), "application/pdf"))]),
      answer("T".repeat(3_300_000)),
      ...renders(30, 0.15),
    ]
    expect(bound(messages).report).toBeUndefined()
  })

  test("until the control plane has taken an upload, images count in full against its body limit", () => {
    // 30 renders of 0.15 MB: 4.5 MB in the body, a few KB as references.
    const messages = [user("Review the renders"), ...renders(30, 0.15)]
    expect(bound(messages).report).toBeUndefined()
    const { messages: sent, report } = bound(messages, "inline")
    expect(report?.removed).toBeGreaterThan(0)
    expect(report?.after).toBeLessThanOrEqual(REQUEST_BYTES_LIMIT)
    expect(shown(sent)["render-30.jpg"]).toBe("sent")
  })

  test("an in-process (BYOK) request meets only the provider's limits", () => {
    // 6 MB of text and 4.5 MB of renders: past the hosted body limit, well under the provider's.
    const messages = [user("Review the renders"), answer("T".repeat(6_000_000)), ...renders(30, 0.15)]
    expect(bound(messages, "local").report).toBeUndefined()
    expect(bound([user("Review the deck"), ...renders(32, 0.5)], "local").report?.removed).toBeGreaterThan(0)
  })

  test("past the provider's media limit, the oldest images go first, down to the trim target", () => {
    // 32 renders of 0.5 MB with their data URL prefixes: just over the 16 MB a provider request carries.
    const { messages: sent, report } = bound([user("Review the deck"), ...renders(32, 0.5)])
    const view = shown(sent)
    expect(view["render-32.jpg"]).toBe("sent")
    const removed = Object.keys(view).filter((name) => view[name] === "removed")
    expect(removed).toEqual(removed.map((_, index) => `render-${index + 1}.jpg`))
    // Dropping one render would fit; the trim goes under the target, and putting back the last image
    // it removed would not be.
    const target = UPSTREAM_MEDIA_BYTES * IMAGE_ROOM_KEPT
    expect(removed.length).toBeGreaterThan(1)
    expect(report?.mediaAfter).toBeLessThanOrEqual(target)
    expect((report?.mediaAfter ?? 0) + 500_000).toBeGreaterThan(target)
  })

  test("past the provider's image count, the oldest images go first, down to the trim target", () => {
    const view = shown(bound([user("Review the icons"), ...renders(UPSTREAM_IMAGES + 30, 0.01)]).messages)
    expect(sentNames(view)).toHaveLength(Math.floor(UPSTREAM_IMAGES * IMAGE_ROOM_KEPT))
    expect(view[`render-${UPSTREAM_IMAGES + 30}.jpg`]).toBe("sent")
  })

  test("the next steps keep the same images until the room a trim left runs out", () => {
    // Each removal rewrites the prompt prefix, which costs Claude a full cache write.
    const history = [user("Review the deck"), ...renders(33, 0.5)]
    const first = shown(bound(history).messages)
    let messages = history
    let steps = 0
    for (; steps < 20; steps++) {
      messages = [...messages, ...step([[`render-${34 + steps}.jpg`, 0.5]])]
      const view = shown(bound(messages).messages)
      if (Object.keys(first).some((name) => first[name] !== view[name])) break
    }
    // About 4.8 MB of room: several 0.5 MB renders go by with no change.
    expect(steps).toBeGreaterThanOrEqual(5)
    const later = shown(bound(messages).messages)
    for (const [name, state] of Object.entries(first)) if (state === "removed") expect(later[name]).toBe("removed")
    const stillSent = Object.keys(first).filter((name) => first[name] === "sent")
    const newlyRemoved = stillSent.filter((name) => later[name] === "removed")
    expect(newlyRemoved).toEqual(stillSent.slice(0, newlyRemoved.length))
    expect(newlyRemoved.length).toBeGreaterThan(1)
  })

  test("reasoning details a step copies onto its tool calls are counted once", () => {
    // An Arena contestant's sealed reasoning sits on the step's reasoning part and again on each of
    // its tool calls; the request sends it once, with the reasoning.
    const sealed = { openrouter: { reasoning_details: [{ type: "reasoning.encrypted", data: "S".repeat(150_000) }] } }
    const reasoningStep = (name: string) => {
      const id = `call_${++call}`
      return [
        Message.assistant([
          { type: "reasoning" as const, text: "", providerMetadata: sealed },
          ToolCallPart.make({ id, name: "read", input: { path: name }, providerMetadata: sealed }),
        ]),
        ...step([[name, 0.1]])
          .slice(1)
          .map((message) =>
            message.role === "tool"
              ? Message.tool(ToolResultPart.make({ ...(message.content[0] as ToolResultPart), id }))
              : message,
          ),
      ]
    }
    // Sent once, 16 steps of 150 KB reasoning come to 2.4 MB, under the limit; counted twice they
    // would pass it.
    const messages = [
      user("Review the renders"),
      ...Array.from({ length: 16 }, (_, index) => reasoningStep(`render-${index + 1}.jpg`)).flat(),
    ]
    expect(bound(messages).report).toBeUndefined()
  })

  test("a tool call's extra content still counts", () => {
    // Gemini sends a thought signature back with each tool call.
    const signed = { openrouter: { extraContent: { google: { thought_signature: "G".repeat(400_000) } } } }
    const messages = [user("Review the renders")]
    for (let index = 0; index < 12; index++) {
      const [assistant, ...rest] = step([[`render-${index + 1}.jpg`, 0.05]])
      const part = assistant.content[0] as ToolCallPart
      messages.push(Message.assistant([ToolCallPart.make({ ...part, providerMetadata: signed })]), ...rest)
    }
    // 12 x 400 KB signatures pass the body limit only if they count.
    expect(bound(messages).report?.removed).toBeGreaterThan(0)
  })

  test("the user's pasted images are removed only as far as it takes to fit", () => {
    // 18 MB: dropping one attachment fits (13.5 MB); trimming to the tool-image target would drop two.
    const messages = [
      user("Match these designs", [
        ["attachment-1.png", 4.5],
        ["attachment-2.png", 4.5],
        ["attachment-3.png", 4.5],
      ]),
      ...step([["render-1.jpg", 4.5]]),
    ]
    const view = shown(bound(messages).messages)
    expect(view["attachment-1.png"]).toBe("removed")
    expect(view["attachment-2.png"]).toBe("sent")
    expect(view["attachment-3.png"]).toBe("sent")
  })

  test("a step whose images do not fit together sends the first ones and defers the rest", () => {
    // Five slides read at once, 22.5 MB together.
    const slides = [1, 2, 3, 4, 5].map((index) => [`slide-${index}.png`, 4.5] as const)
    const first = [user("QA the slides"), ...step(slides)]
    // Three fit under 16 MB; adding a fourth would not.
    expect(shown(bound(first).messages)).toEqual({
      "slide-1.png": "sent",
      "slide-2.png": "sent",
      "slide-3.png": "sent",
      "slide-4.png": "deferred",
      "slide-5.png": "deferred",
    })

    // Reading the deferred ones again makes room by removing the previous step's images.
    const second = [...first, ...step([slides[3], slides[4]])]
    const { messages: secondSent, report } = bound(second)
    expect(report?.mediaAfter).toBeLessThanOrEqual(UPSTREAM_MEDIA_BYTES)
    expect(shown(secondSent.slice(first.length))).toEqual({ "slide-4.png": "sent", "slide-5.png": "sent" })
    expect(shown(secondSent.slice(0, first.length))).toMatchObject({
      "slide-1.png": "removed",
      "slide-2.png": "removed",
      "slide-3.png": "removed",
    })
  })

  test("an image too large to upload or fit alone gets a note asking for a smaller file, and stays out", () => {
    const messages = [user("Look at the poster"), ...step([["poster.png", 6.2]])]
    const sent = bound(messages).messages
    const note = JSON.stringify(sent.at(-1))
    expect(shown(sent)).toEqual({ "poster.png": "oversized" })
    expect(note).toContain("it is 6.2 MB encoded")
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
      ...renders(20, 0.8),
    ]
    const view = shown(bound(messages).messages)
    expect(view["attachment-1.png"]).toBe("sent")
    expect(view["attachment-2.png"]).toBe("sent")
    expect(view["render-1.jpg"]).toBe("removed")
  })

  test("a removed pasted image asks the user, a removed tool image asks for a new read", () => {
    const pasted = JSON.stringify(
      bound([
        user("Match these designs", [
          ["attachment-1.png", 4.5],
          ["attachment-2.png", 4.5],
          ["attachment-3.png", 4.5],
        ]),
        ...step([["render-1.jpg", 4.5]]),
      ]).messages,
    )
    expect(pasted).toContain("Image attachment-1.png was removed")
    expect(pasted).toContain("ask the user to attach it again")
    const read = JSON.stringify(bound([user("Review the renders"), ...renders(4, 4.5)]).messages)
    expect(read).toContain("Image render-1.jpg was removed")
    expect(read).toContain("Use what you wrote down about it. If you need to see it again, read the file again")
  })

  test("an agent re-reading images in a loop stops getting them back", () => {
    // Like DeepSeek in QA: it needs all five slides, keeps no notes, and reads them one at a time forever.
    const slides = [3.6, 3.9, 5.4, 4.2, 4.5].map((megabytes, index) => [`slide-${index + 1}.png`, megabytes] as const)
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
      for (const index of [1, 2, 3]) messages = [...messages, ...step([[`slide-${index}.png`, 2.7, version]])]
    const last = shown(bound([...messages, ...step([["slide-1.png", 2.7, "Z"]])]).messages.slice(-1))
    expect(last).toEqual({ "slide-1.png": "sent" })
  })

  test("the history itself is never changed", () => {
    const messages = [user("Review the deck"), ...step([["poster.png", 6.2]])]
    const before = JSON.stringify(messages)
    bound(messages)
    expect(JSON.stringify(messages)).toBe(before)
  })
})
