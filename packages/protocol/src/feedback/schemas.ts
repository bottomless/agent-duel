import { z } from "zod";
import { AgentTimelineItemPayloadSchema } from "../messages.js";

const boundedIdentifier = z.string().trim().min(1).max(256);

export const feedbackDetailsSchema = z
  .object({
    appVersion: z.string().trim().min(1).max(64).nullable(),
    platform: z.enum(["desktop", "browser"]),
    operatingSystem: z.string().trim().min(1).max(128),
    locale: z.string().trim().min(1).max(64),
    screen: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type FeedbackDetails = z.infer<typeof feedbackDetailsSchema>;

const feedbackBaseSchema = z.object({
  id: z.uuid(),
  details: feedbackDetailsSchema.optional(),
});

export const feedbackContextTargetSchema = z
  .object({
    agentId: boundedIdentifier,
    workspaceId: boundedIdentifier,
  })
  .strict();
export type FeedbackContextTarget = z.infer<typeof feedbackContextTargetSchema>;

export const feedbackTimelineRowSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    timestamp: z.iso.datetime(),
    item: AgentTimelineItemPayloadSchema,
    providerMessageId: z.string().max(512).optional(),
  })
  .strict();
export type FeedbackTimelineRow = z.infer<typeof feedbackTimelineRowSchema>;

export const feedbackContextMetadataSchema = z
  .object({
    version: z.literal(1),
    capturedAt: z.iso.datetime(),
    agent: z
      .object({
        id: boundedIdentifier,
        provider: z.string().trim().min(1).max(64),
        sessionId: z.string().trim().min(1).max(512).nullable(),
      })
      .strict(),
    git: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("not_git") }).strict(),
      z
        .object({
          kind: z.literal("git"),
          branch: z.string().max(512).nullable(),
          baseRef: z.string().max(512).nullable(),
          upstreamRef: z.string().max(512).nullable(),
          isDirty: z.boolean(),
          aheadBehind: z
            .object({ ahead: z.number().int(), behind: z.number().int() })
            .strict()
            .nullable(),
          diffStat: z
            .object({ additions: z.number().int(), deletions: z.number().int() })
            .strict()
            .nullable(),
          status: z.string().max(200_000),
        })
        .strict(),
      z.object({ kind: z.literal("unavailable"), reason: z.string().max(512) }).strict(),
    ]),
  })
  .strict();
export type FeedbackContextMetadata = z.infer<typeof feedbackContextMetadataSchema>;

export const feedbackContextSchema = feedbackContextMetadataSchema
  .extend({ timeline: z.array(feedbackTimelineRowSchema) })
  .strict();
export type FeedbackContext = z.infer<typeof feedbackContextSchema>;

export const feedbackContextMaximumBytes = 12 * 1024 * 1024;
export const feedbackContextMaximumAttempts = 4;

export const feedbackContextTransferSchema = z
  .object({
    maxBytes: z.literal(feedbackContextMaximumBytes),
    encodedBytes: z.number().int().positive().max(feedbackContextMaximumBytes),
    originalTimelineItems: z.number().int().nonnegative(),
    includedTimelineItems: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export type FeedbackContextTransfer = z.infer<typeof feedbackContextTransferSchema>;

export const feedbackContextStreamHeaderSchema = z
  .object({
    type: z.literal("context"),
    feedbackId: z.uuid(),
    attempt: z.number().int().positive().max(feedbackContextMaximumAttempts),
    context: feedbackContextMetadataSchema,
    transfer: feedbackContextTransferSchema,
  })
  .strict();
export type FeedbackContextStreamHeader = z.infer<typeof feedbackContextStreamHeaderSchema>;

export const feedbackContextStreamTimelineSchema = z
  .object({ type: z.literal("timeline"), row: feedbackTimelineRowSchema })
  .strict();
export type FeedbackContextStreamTimeline = z.infer<typeof feedbackContextStreamTimelineSchema>;

export const feedbackContextFailureSchema = z
  .object({
    feedbackId: z.uuid(),
    attempts: z.number().int().nonnegative().max(feedbackContextMaximumAttempts),
    error: z.string().trim().min(1).max(512),
  })
  .strict();
export type FeedbackContextFailure = z.infer<typeof feedbackContextFailureSchema>;

const sidebarFeedbackSchema = feedbackBaseSchema
  .extend({
    source: z.literal("sidebar"),
    category: z.enum(["general", "bug", "idea"]),
    message: z.string().trim().min(1).max(5_000),
    contextTarget: feedbackContextTargetSchema.optional(),
  })
  .strict();

const chatFeedbackSchema = feedbackBaseSchema
  .extend({
    source: z.literal("chat"),
    rating: z.enum(["not_great", "okay", "great"]),
    message: z.string().trim().max(2_000).optional(),
    battleId: boundedIdentifier,
    agentId: boundedIdentifier,
    workspaceId: boundedIdentifier,
  })
  .strict();

export const feedbackSubmissionSchema = z.discriminatedUnion("source", [
  sidebarFeedbackSchema,
  chatFeedbackSchema,
]);
export type FeedbackSubmission = z.infer<typeof feedbackSubmissionSchema>;

export const feedbackSubmissionResponseSchema = z.object({
  id: z.string(),
  emailed: z.boolean(),
});
export type FeedbackSubmissionResponse = z.infer<typeof feedbackSubmissionResponseSchema>;
