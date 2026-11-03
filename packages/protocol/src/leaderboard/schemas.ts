import { z } from "zod";

export const leaderboardMinimumVotes = 50;
export const leaderboardQuerySchema = z.object({}).strict();
export const leaderboardRatingSchema = z.object({
  model: z.string(),
  rating: z.number().finite(),
  lower95: z.number().finite(),
  upper95: z.number().finite(),
  votes: z.number().int().nonnegative(),
  tokensPerSecond: z.number().finite().positive().nullable(),
});
export type LeaderboardRating = z.infer<typeof leaderboardRatingSchema>;

export const leaderboardDatasetSchema = z.object({
  computedAt: z.string().datetime(),
  eligibleVotes: z.number().int().nonnegative(),
  minimumVotes: z.literal(50),
  excludeEarlyVotes: z.boolean(),
  excluded: z.object({
    missingData: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    subagents: z.number().int().nonnegative(),
    earlyVotes: z.number().int().nonnegative(),
  }),
  ratings: z.array(leaderboardRatingSchema),
  disconnected: z.boolean(),
});
export type LeaderboardDataset = z.infer<typeof leaderboardDatasetSchema>;

export const leaderboardResponseSchema = z.object({
  withEarlyVotes: leaderboardDatasetSchema,
  withoutEarlyVotes: leaderboardDatasetSchema,
});
export type LeaderboardResponse = z.infer<typeof leaderboardResponseSchema>;
