import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ArenaAttachments } from "@/arena/attachments"
import type { Image } from "@/image/image"

const unchanged: Image.Interface["normalize"] = (input) => Effect.succeed(input)

function prepare(text: string, inputs: readonly ArenaAttachments.Input[], normalize = unchanged) {
  return Effect.runPromise(ArenaAttachments.prepare(text, inputs, normalize))
}

function failure(text: string, inputs: readonly ArenaAttachments.Input[], normalize = unchanged) {
  return Effect.runPromise(Effect.flip(ArenaAttachments.prepare(text, inputs, normalize))).then(
    (error) => error.message,
  )
}

const png = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } as const
const element = { type: "text", label: "Review comment", text: "<div class='hero'>Hi</div>" } as const

describe("ArenaAttachments.prepare", () => {
  test("puts the text first, then images under neutral names, then rendered attachments", async () => {
    const prepared = await prepare("Fix the hero", [element, png, { ...png, mimeType: "image/jpeg" }])

    expect(prepared.prompt.parts).toEqual([
      { type: "text", text: "Fix the hero" },
      { type: "file", mime: "image/png", filename: "attachment-1.png", url: "data:image/png;base64,iVBORw0KGgo=" },
      { type: "file", mime: "image/jpeg", filename: "attachment-2.jpg", url: "data:image/jpeg;base64,iVBORw0KGgo=" },
      {
        type: "text",
        text: "<div class='hero'>Hi</div>",
        metadata: { [ArenaAttachments.METADATA_KEY]: { label: "Review comment", kind: "text" } },
      },
    ])
    expect(prepared.summary).toEqual([
      { kind: "image", label: "Image 1" },
      { kind: "image", label: "Image 2" },
      { kind: "text", label: "Review comment", excerpt: "<div class='hero'>Hi</div>" },
    ])
  })

  test("names an image by the format it was resized into", async () => {
    const toJpeg: Image.Interface["normalize"] = (input) =>
      Effect.succeed({ ...input, mime: "image/jpeg", url: "data:image/jpeg;base64,AAAA" })

    const prepared = await prepare("", [png], toJpeg)

    expect(prepared.prompt.parts).toEqual([
      { type: "file", mime: "image/jpeg", filename: "attachment-1.jpg", url: "data:image/jpeg;base64,AAAA" },
    ])
  })

  test("resizes every image to the battle limits", async () => {
    const seen: unknown[] = []
    const record: Image.Interface["normalize"] = (input, limits) => {
      seen.push(limits)
      return Effect.succeed(input)
    }

    await prepare("", [png, png], record)

    expect(seen).toEqual([ArenaAttachments.IMAGE_LIMITS, ArenaAttachments.IMAGE_LIMITS])
  })

  test("refuses more images than a battle message can carry", async () => {
    const images = Array.from({ length: ArenaAttachments.MAX_IMAGES + 1 }, () => png)

    expect(await failure("", images)).toBe(`A battle message can include at most ${ArenaAttachments.MAX_IMAGES} images`)
  })

  test("refuses image formats the contestants cannot all read", async () => {
    expect(await failure("", [{ ...png, mimeType: "image/svg+xml" }])).toBe(
      "Battles cannot include image/svg+xml images",
    )
  })

  test("refuses attached text past the message budget", async () => {
    expect(await failure("", [{ ...element, text: "x".repeat(300 * 1024) }])).toBe(
      "Attached text is too large for a battle message",
    )
  })

  test("says which image could not be resized", async () => {
    const tooLarge: Image.Interface["normalize"] = () => Effect.fail(new Error("too large") as never)

    expect(await failure("", [png, png], tooLarge)).toBe("Image 1 cannot be attached: too large")
  })
})

describe("ArenaAttachments.prepare with uploaded files", () => {
  const upload = {
    type: "file",
    path: "/home/ada/.paseo/uploads/upload_1/coffee_poem.pdf",
    name: "coffee_poem.pdf",
    mimeType: "application/pdf",
    size: 48213,
  } as const

  test("points both contestants at the upload the way a single agent is told about it", async () => {
    const prepared = await prepare("Summarise the poem", [upload])

    expect(prepared.prompt.parts).toEqual([
      { type: "text", text: "Summarise the poem" },
      {
        type: "text",
        text: [
          "Uploaded file: coffee_poem.pdf",
          "Path: /home/ada/.paseo/uploads/upload_1/coffee_poem.pdf",
          "MIME: application/pdf",
          "Size: 48213 bytes",
        ].join("\n"),
        metadata: { [ArenaAttachments.METADATA_KEY]: { label: "coffee_poem.pdf", kind: "file" } },
      },
    ])
    expect(prepared.summary).toEqual([
      { kind: "file", label: "coffee_poem.pdf", excerpt: "application/pdf, 48213 bytes" },
    ])
  })

  test("lets the contestants read each upload's own directory and nothing else", async () => {
    const second = { ...upload, path: "/home/ada/.paseo/uploads/upload_2/notes.csv", name: "notes.csv" }

    const prepared = await prepare("", [upload, second, upload])

    expect(prepared.prompt.readable).toEqual(["/home/ada/.paseo/uploads/upload_1", "/home/ada/.paseo/uploads/upload_2"])
  })

  test("refuses an upload named by a relative path", async () => {
    expect(await failure("", [{ ...upload, path: "uploads/upload_1/coffee_poem.pdf" }])).toBe(
      "An uploaded file must be named by its absolute path",
    )
  })
})

describe("ArenaAttachments.describeForJudge", () => {
  test("lists images and quotes rendered attachments", () => {
    expect(
      ArenaAttachments.describeForJudge([
        { kind: "image", label: "Image 1" },
        { kind: "text", label: "Review comment", excerpt: "<div>Hi</div>" },
      ]),
    ).toBe("- Image 1: an image both contestants could see and you cannot\n- Review comment:\n<div>Hi</div>")
  })

  test("tells the judge a file was there to open", () => {
    expect(
      ArenaAttachments.describeForJudge([
        { kind: "file", label: "coffee_poem.pdf", excerpt: "application/pdf, 48213 bytes" },
      ]),
    ).toBe("- coffee_poem.pdf: a file both contestants could open (application/pdf, 48213 bytes)")
  })

  test("says nothing when the prompt had no attachments", () => {
    expect(ArenaAttachments.describeForJudge(undefined)).toBeUndefined()
    expect(ArenaAttachments.describeForJudge([])).toBeUndefined()
  })
})
