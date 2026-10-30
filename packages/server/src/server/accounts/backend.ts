import { z } from "zod";
import type { Logger } from "pino";
import {
  accountUserSchema,
  authMethodsResponseSchema,
  currentSessionResponseSchema,
  sessionMethodSchema,
  signInMethodSchema,
  startAnonymousSessionResponseSchema,
  type OpenSignInFlowRequest,
  type AcceptTermsRequest,
  type StartAnonymousSessionRequest,
} from "@getpaseo/protocol/accounts/schemas";
import { clientHeaders } from "./config.js";

export class AccountsBackendUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super("The accounts service is unavailable");
    this.name = "AccountsBackendUnavailableError";
  }
}

export class AccountsRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The control plane's machine-readable reason, such as `sign_in_required`. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "AccountsRequestError";
  }
}

const openedFlowSchema = z.object({
  flowId: z.string(),
  secret: z.string(),
  expiresAt: z.string(),
});
const claimedFlowSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("expired") }),
  z.object({
    status: z.literal("signed-in"),
    sessionToken: z.string(),
    method: signInMethodSchema,
    user: accountUserSchema,
    /**
     * The anonymous account this sign-in merged into an existing one. The daemon moves its local
     * records to the signed-in account (`adoptAccounts` in the Arena credentials).
     */
    mergedFrom: z.string().optional(),
  }),
]);
const okSchema = z.object({ ok: z.literal(true) });

export type AccountUser = z.infer<typeof accountUserSchema>;
export type SignInMethod = z.infer<typeof signInMethodSchema>;
export type SessionMethod = z.infer<typeof sessionMethodSchema>;
export type ClaimedFlow = z.infer<typeof claimedFlowSchema>;

export class AccountsBackend {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly logger: Logger,
    private readonly appVersion: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { method?: "GET" | "POST"; body?: unknown; token?: string } = {},
  ): Promise<T> {
    try {
      const response = await fetch(`${this.baseUrl}/api/auth${path}`, {
        method: options.method ?? "POST",
        headers: {
          Accept: "application/json",
          ...clientHeaders(this.appVersion),
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const body =
          payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        const message =
          typeof body.error === "string"
            ? body.error
            : `Accounts request failed with status ${response.status}`;
        if (response.status >= 500) throw new AccountsBackendUnavailableError(new Error(message));
        throw new AccountsRequestError(
          response.status,
          message,
          typeof body.code === "string" ? body.code : undefined,
        );
      }
      return schema.parse(payload);
    } catch (error) {
      if (error instanceof AccountsBackendUnavailableError) throw error;
      if (error instanceof AccountsRequestError) throw error;
      this.logger.warn({ err: error, path }, "Control-plane accounts request failed");
      throw new AccountsBackendUnavailableError(error);
    }
  }

  methods() {
    return this.request("/methods", authMethodsResponseSchema, { method: "GET" });
  }

  /** `anonymousToken` is the anonymous session the sign-in upgrades, when there is one. */
  openFlow(input: OpenSignInFlowRequest, anonymousToken?: string) {
    return this.request("/flow", openedFlowSchema, { body: input, token: anonymousToken });
  }

  startAnonymous(input: StartAnonymousSessionRequest) {
    return this.request("/anonymous", startAnonymousSessionResponseSchema, { body: input });
  }

  claimFlow(input: { flowId: string; secret: string }) {
    return this.request("/flow/claim", claimedFlowSchema, { body: input });
  }

  async sendMagicLink(input: { email: string; flowId: string }) {
    await this.request("/magic-link", okSchema, { body: input });
  }

  oauthStartUrl(provider: "google" | "github", flowId: string) {
    return `${this.baseUrl}/api/auth/oauth/${provider}/start?flow=${encodeURIComponent(flowId)}`;
  }

  async revokeSession(token: string) {
    await this.request("/sign-out", okSchema, { token, body: {} });
  }

  currentSession(token: string) {
    return this.request("/session", currentSessionResponseSchema, { method: "GET", token });
  }

  acceptTerms(token: string, input: AcceptTermsRequest) {
    return this.request("/accept-terms", currentSessionResponseSchema, { token, body: input });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
