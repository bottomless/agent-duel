import path from "node:path"
import { Effect, Schema } from "effect"
import type { Image } from "@/image/image"
import type { SessionPrompt } from "@/session/prompt"
import type { AttachmentSummary } from "./records"

/**
 * What arrives with a battle prompt: pasted images as bytes, context the daemon rendered to text,
 * and uploaded files by the path the daemon stored them at, for the contestants to open themselves
 * as a single agent would.
 */
export const Input = Schema.Union([
  Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text"), label: Schema.String, text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("file"),
    path: Schema.String,
    name: Schema.String,
    mimeType: Schema.String,
    size: Schema.Number,
  }),
])
export type Input = typeof Input.Type

export type Summary = AttachmentSummary

/**
 * What both contestants are sent, and the directories they may read outside their worktree to
 * open the uploaded files it names.
 */
export type ContestantPrompt = {
  readonly parts: SessionPrompt.PromptInput["parts"]
  readonly readable: readonly string[]
}

/**
 * Marks a text part as an attachment rather than the user's words, with the label the app shows for
 * it and whether it is an uploaded file or text, which the label alone cannot say. The one text
 * metadata key `ArenaPrivacy` keeps, so the chat's history can tell them apart.
 */
export const METADATA_KEY = "arenaAttachment"

// The app holds a battle message to this count before it sends
// (`ARENA_MAX_IMAGES` in packages/app/src/arena/constants.ts).
export const MAX_IMAGES = 4
const MAX_TEXT_BYTES = 256 * 1024
const JUDGE_EXCERPT_CHARS = 1_000
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

/**
 * Every model call re-sends the whole conversation through the control plane, whose hosted
 * function accepts about 4.5 MB per request, so a message's images together stay near half of that.
 * 1568 px is the long edge the pool's vision models read at full detail.
 */
export const IMAGE_LIMITS: Image.Limits = { maxWidth: 1568, maxHeight: 1568, maxBase64Bytes: 600 * 1024 }

/**
 * Turn a prompt and its attachments into the parts both contestants receive. Images are resized
 * here, once, so the two sides get identical bytes and an image too large to send fails before a
 * turn is admitted. File names are neutral: a user's name for a screenshot reaches the model, the
 * transcripts, and the judge.
 */
export const prepare = Effect.fn("ArenaAttachments.prepare")(function* (
  text: string,
  inputs: readonly Input[],
  normalize: Image.Interface["normalize"],
) {
  const images = inputs.filter((input) => input.type === "image")
  const texts = inputs.filter((input) => input.type === "text")
  const uploads = inputs.filter((input) => input.type === "file")
  if (uploads.some((input) => !path.isAbsolute(input.path))) {
    return yield* Effect.fail(new Error("An uploaded file must be named by its absolute path"))
  }
  if (images.length > MAX_IMAGES) {
    return yield* Effect.fail(new Error(`A battle message can include at most ${MAX_IMAGES} images`))
  }
  if (texts.reduce((total, input) => total + Buffer.byteLength(input.text, "utf8"), 0) > MAX_TEXT_BYTES) {
    return yield* Effect.fail(new Error("Attached text is too large for a battle message"))
  }
  const files = yield* Effect.forEach(images, (input, index) => {
    const extension = IMAGE_EXTENSIONS[input.mimeType]
    if (!extension) return Effect.fail(new Error(`Battles cannot include ${input.mimeType} images`))
    return normalize({ mime: input.mimeType, url: `data:${input.mimeType};base64,${input.data}` }, IMAGE_LIMITS).pipe(
      Effect.mapError((cause) => new Error(`Image ${index + 1} cannot be attached: ${cause.message}`)),
      Effect.map((image) => ({
        type: "file" as const,
        mime: image.mime,
        filename: `attachment-${index + 1}.${IMAGE_EXTENSIONS[image.mime] ?? extension}`,
        url: image.url,
      })),
    )
  })
  const others = inputs.filter((input) => input.type !== "image")
  const parts: ContestantPrompt["parts"] = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...files,
    ...others.map((input) => ({
      type: "text" as const,
      text: input.type === "file" ? uploadNote(input) : input.text,
      metadata: {
        [METADATA_KEY]:
          input.type === "file" ? { label: input.name, kind: "file" } : { label: input.label, kind: "text" },
      },
    })),
  ]
  const summary: Summary[] = [
    ...images.map((_, index) => ({ kind: "image" as const, label: `Image ${index + 1}` })),
    ...others.map((input) =>
      input.type === "file"
        ? { kind: "file" as const, label: input.name, excerpt: `${input.mimeType}, ${input.size} bytes` }
        : { kind: "text" as const, label: input.label, excerpt: input.text.slice(0, JUDGE_EXCERPT_CHARS) },
    ),
  ]
  // Each upload sits alone in its own directory, so this lets a contestant open those files only.
  const readable = [...new Set(uploads.map((input) => path.dirname(input.path)))]
  return { prompt: { parts, readable } satisfies ContestantPrompt, summary }
})

/** The judge reads text only, so it gets told what the contestants were shown alongside the prompt. */
export function describeForJudge(summary: readonly Summary[] | undefined) {
  if (!summary?.length) return undefined
  return summary
    .map((item) => {
      if (item.kind === "image") return `- ${item.label}: an image both contestants could see and you cannot`
      if (item.kind === "file") return `- ${item.label}: a file both contestants could open (${item.excerpt ?? ""})`
      return `- ${item.label}:\n${item.excerpt ?? ""}`
    })
    .join("\n")
}

/** The note a single agent gets for an upload, so a contestant reads it the same way. */
function uploadNote(input: Extract<Input, { type: "file" }>) {
  return [
    `Uploaded file: ${input.name}`,
    `Path: ${input.path}`,
    `MIME: ${input.mimeType}`,
    `Size: ${input.size} bytes`,
  ].join("\n")
}

export * as ArenaAttachments from "./attachments"
