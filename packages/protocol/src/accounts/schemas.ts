import { z } from "zod";

export const signInMethodSchema = z.enum(["email", "google", "github"]);
export type SignInMethod = z.infer<typeof signInMethodSchema>;

export const accountUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});
export type AccountUser = z.infer<typeof accountUserSchema>;

export const authMethodsResponseSchema = z.object({
  /** False when the daemon has no accounts database and therefore no sign-in. */
  enabled: z.boolean(),
  methods: z.array(signInMethodSchema),
});
export type AuthMethodsResponse = z.infer<typeof authMethodsResponseSchema>;

// A desktop return link can only activate an existing loopback listener. It
// never carries the session token and cannot redirect to an arbitrary site.
export const desktopSignInReturnUrlSchema = z
  .string()
  .regex(/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/accounts\/return\/[a-f0-9]{64}$/)
  .refine((value) => Number(value.split(":")[2]?.split("/")[0]) <= 65535);

export const openSignInFlowRequestSchema = z.object({
  desktopReturnUrl: desktopSignInReturnUrlSchema.optional(),
});
export type OpenSignInFlowRequest = z.infer<typeof openSignInFlowRequestSchema>;

export const openSignInFlowResponseSchema = z.object({
  flowId: z.string(),
  secret: z.string(),
  expiresAt: z.string(),
});
export type OpenSignInFlowResponse = z.infer<typeof openSignInFlowResponseSchema>;

export const claimSignInFlowRequestSchema = z.object({
  flowId: z.string(),
  secret: z.string(),
});
export type ClaimSignInFlowRequest = z.infer<typeof claimSignInFlowRequestSchema>;

export const claimSignInFlowResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("expired") }),
  z.object({
    status: z.literal("signed-in"),
    sessionToken: z.string(),
    method: signInMethodSchema,
    user: accountUserSchema,
  }),
]);
export type ClaimSignInFlowResponse = z.infer<typeof claimSignInFlowResponseSchema>;

export const sendMagicLinkRequestSchema = z.object({
  email: z.string(),
  flowId: z.string(),
});
export type SendMagicLinkRequest = z.infer<typeof sendMagicLinkRequestSchema>;

export const currentSessionResponseSchema = z.object({
  user: accountUserSchema,
  method: signInMethodSchema,
});
export type CurrentSessionResponse = z.infer<typeof currentSessionResponseSchema>;

/** Header the app presents on HTTP requests once it holds a session token. */
export const SESSION_HEADER = "x-paseo-session";

/**
 * Close codes for a refused socket. A liveness probe must read these as "the
 * daemon is up and answering" — it is refusing the caller, not absent — or the
 * desktop shell concludes its daemon died and starts a second one.
 */
export const WS_CLOSE_SIGN_IN_REQUIRED = 4402;
export const WS_CLOSE_ACCOUNTS_UNAVAILABLE = 4503;

/** Close reasons paired with the codes above; probes match on these. */
export const SIGN_IN_REQUIRED_REASON = "Sign in to use Agent Duel";
export const ACCOUNTS_UNAVAILABLE_REASON = "Accounts service starting";

/** WebSocket subprotocol prefix carrying the same token on the socket handshake. */
export const SESSION_WS_PROTOCOL_PREFIX = "paseo.session.";

export function buildSessionWsProtocol(token: string): string {
  return `${SESSION_WS_PROTOCOL_PREFIX}${token}`;
}

export function extractSessionWsToken(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }
  for (const entry of headerValue.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.startsWith(SESSION_WS_PROTOCOL_PREFIX)) {
      const token = trimmed.slice(SESSION_WS_PROTOCOL_PREFIX.length);
      if (token) {
        return token;
      }
    }
  }
  return null;
}
