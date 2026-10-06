import { z } from "zod";
import type { Logger } from "pino";

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
const accountUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});
const methodsSchema = z.object({ enabled: z.boolean(), methods: z.array(signInMethodSchema) });
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

export class AccountsBackend {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly logger: Logger,
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
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
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
    return this.request("/methods", methodsSchema, { method: "GET" });
  }

  openFlow(input: { desktopReturnUrl?: string } = {}) {
    return this.request("/flow", openedFlowSchema, { body: input });
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

  close(): Promise<void> {
    return Promise.resolve();
  }
}
