import { z } from "zod";
import type { Logger } from "pino";
import {
  accountUserSchema,
  authMethodsResponseSchema,
  currentSessionResponseSchema,
  type OpenSignInFlowRequest,
  type AcceptTermsRequest,
  type AppOpenedRequest,
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
  ) {
    super(message);
    this.name = "AccountsRequestError";
  }
}

const signInMethodSchema = z.enum(["email", "google", "github"]);
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
  }),
]);
const okSchema = z.object({ ok: z.literal(true) });

export type AccountUser = z.infer<typeof accountUserSchema>;
export type SignInMethod = z.infer<typeof signInMethodSchema>;
export type ClaimedFlow = z.infer<typeof claimedFlowSchema>;

// The open report waits on nothing the user sees, so a slow control plane only loses one count.
const APP_OPENED_TIMEOUT_MS = 5_000;
// The app claims one poll at a time, so a claim that never answers would hold sign-in up for good.
// Long enough for a cold control plane. The control plane answers a repeated claim with the same
// session for a minute after the first, so the app's next poll recovers a claim cut off here.
const CLAIM_TIMEOUT_MS = 15_000;

export interface AccountsBackendOptions {
  /** A source build (`npm run dev:desktop`); the control plane leaves its sign-in counts out. */
  readonly development?: boolean;
  readonly appOpenedTimeoutMs?: number;
  readonly claimTimeoutMs?: number;
}

export class AccountsBackend {
  private readonly baseUrl: string;
  private readonly buildHeaders: Record<string, string>;

  constructor(
    baseUrl: string,
    private readonly logger: Logger,
    private readonly appVersion: string,
    private readonly options: AccountsBackendOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.buildHeaders = options.development ? { "X-Agent-Duel-Build": "development" } : {};
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { method?: "GET" | "POST"; body?: unknown; token?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    try {
      const response = await fetch(`${this.baseUrl}/api/auth${path}`, {
        method: options.method ?? "POST",
        headers: {
          Accept: "application/json",
          ...clientHeaders(this.appVersion),
          ...this.buildHeaders,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        ...(options.timeoutMs === undefined
          ? {}
          : { signal: AbortSignal.timeout(options.timeoutMs) }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof payload.error === "string"
            ? payload.error
            : `Accounts request failed with status ${response.status}`;
        if (response.status >= 500) throw new AccountsBackendUnavailableError(new Error(message));
        throw new AccountsRequestError(response.status, message);
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

  openFlow(input: OpenSignInFlowRequest) {
    return this.request("/flow", openedFlowSchema, { body: input });
  }

  claimFlow(input: { flowId: string; secret: string }) {
    return this.request("/flow/claim", claimedFlowSchema, {
      body: input,
      timeoutMs: this.options.claimTimeoutMs ?? CLAIM_TIMEOUT_MS,
    });
  }

  async sendMagicLink(input: { email: string; flowId: string }) {
    await this.request("/magic-link", okSchema, { body: input });
  }

  /**
   * Counts one app open at the control plane. Never throws; gives up after a few seconds.
   * Resolves whether the control plane answered 2xx. It answers a first open only once the open
   * is counted, and any other open at once.
   */
  async appOpened(input: AppOpenedRequest): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/auth/opened`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...clientHeaders(this.appVersion),
          ...this.buildHeaders,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.options.appOpenedTimeoutMs ?? APP_OPENED_TIMEOUT_MS),
      });
      // An older control plane answers 404 and one that rejects the body answers 400; a first open
      // that was not counted gets 429 or 503. The count is lost and nothing else changes. Only the
      // status is logged, at warn because daemon.log keeps info and above by default and a missing
      // route must show there.
      if (!response.ok) {
        this.logger.warn({ status: response.status }, "Control-plane app open report refused");
      }
      await response.body?.cancel();
      return response.ok;
    } catch (error) {
      this.logger.debug({ err: error }, "Control-plane app open report failed");
      return false;
    }
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
