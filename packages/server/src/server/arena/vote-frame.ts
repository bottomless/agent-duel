import type { Logger } from "pino";
import { z } from "zod";
import { readArenaCredentials } from "../accounts/credentials.js";

const TicketResponseSchema = z.object({ url: z.string().url() });

interface VoteFrameRequest {
  readonly kind: "battle" | "single";
  readonly scopeId: string;
}

interface VoteFrameOptions {
  readonly logger: Pick<Logger, "warn">;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Asks the control plane for the vote frame of one battle turn or rating. A BYOK daemon has no
 * control plane and answers null; so does a failed request, because the app then votes without the
 * frame and the reveal records the vote as unsigned rather than refusing it.
 */
export async function requestVoteFrameUrl(
  request: VoteFrameRequest,
  options: VoteFrameOptions,
): Promise<string | null> {
  const credentials = readArenaCredentials()?.credentials;
  if (credentials?.mode !== "hosted") return null;
  const execute = options.fetchImpl ?? fetch;
  try {
    const response = await execute(`${credentials.controlPlaneUrl}/api/arena/vote-frame/tickets`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ kind: request.kind, scopeID: request.scopeId }),
    });
    if (!response.ok) {
      options.logger.warn({ status: response.status }, "Vote frame ticket was refused");
      return null;
    }
    return TicketResponseSchema.parse(await response.json()).url;
  } catch (error) {
    options.logger.warn({ err: error }, "Vote frame ticket is unavailable");
    return null;
  }
}
