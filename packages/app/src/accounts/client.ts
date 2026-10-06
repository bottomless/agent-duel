import {
  authMethodsResponseSchema,
  claimSignInFlowResponseSchema,
  currentSessionResponseSchema,
  openSignInFlowResponseSchema,
  SESSION_HEADER,
  type AuthMethodsResponse,
  type ClaimSignInFlowResponse,
  type CurrentSessionResponse,
  type OpenSignInFlowResponse,
  type OpenSignInFlowRequest,
  type SignInMethod,
} from "@getpaseo/protocol/accounts/schemas";

export interface AccountsEndpoint {
  readonly baseUrl: string;
  readonly authHeader: string | null;
  readonly daemonPassword: string | null;
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

const errorBodySchema = { error: "" };

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as typeof errorBodySchema).error;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return fallback;
}

function headersFor(endpoint: AccountsEndpoint, sessionToken: string | null): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.daemonPassword) {
    headers.Authorization = `Bearer ${endpoint.daemonPassword}`;
  } else if (endpoint.authHeader) {
    headers.Authorization = endpoint.authHeader;
  }
  if (sessionToken) {
    headers[SESSION_HEADER] = sessionToken;
  }
  return headers;
}

async function request(
  endpoint: AccountsEndpoint,
  input: { path: string; method: "GET" | "POST"; body?: unknown; sessionToken?: string | null },
): Promise<unknown> {
  const response = await fetch(new URL(input.path, endpoint.baseUrl).toString(), {
    method: input.method,
    headers: headersFor(endpoint, input.sessionToken ?? null),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  if (!response.ok) {
    throw new AccountsRequestError(
      response.status,
      await readErrorMessage(response, `Request failed with ${response.status}`),
    );
  }
  return response.json();
}

export async function fetchAuthMethods(endpoint: AccountsEndpoint): Promise<AuthMethodsResponse> {
  const body = await request(endpoint, { path: "/api/auth/methods", method: "GET" });
  return authMethodsResponseSchema.parse(body);
}

export async function fetchCurrentSession(
  endpoint: AccountsEndpoint,
  sessionToken: string,
): Promise<CurrentSessionResponse | null> {
  try {
    const body = await request(endpoint, {
      path: "/api/auth/session",
      method: "GET",
      sessionToken,
    });
    return currentSessionResponseSchema.parse(body);
  } catch (error) {
    if (error instanceof AccountsRequestError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function openSignInFlow(
  endpoint: AccountsEndpoint,
  input: OpenSignInFlowRequest = {},
): Promise<OpenSignInFlowResponse> {
  const body = await request(endpoint, { path: "/api/auth/flow", method: "POST", body: input });
  return openSignInFlowResponseSchema.parse(body);
}

export async function claimSignInFlow(
  endpoint: AccountsEndpoint,
  input: { flowId: string; secret: string },
): Promise<ClaimSignInFlowResponse> {
  const body = await request(endpoint, {
    path: "/api/auth/flow/claim",
    method: "POST",
    body: input,
  });
  return claimSignInFlowResponseSchema.parse(body);
}

export async function sendMagicLink(
  endpoint: AccountsEndpoint,
  input: { email: string; flowId: string },
): Promise<void> {
  await request(endpoint, { path: "/api/auth/magic-link", method: "POST", body: input });
}

export async function signOut(endpoint: AccountsEndpoint, sessionToken: string): Promise<void> {
  await request(endpoint, { path: "/api/auth/sign-out", method: "POST", sessionToken });
}

export function buildOAuthStartUrl(
  endpoint: AccountsEndpoint,
  input: { provider: Exclude<SignInMethod, "email">; flowId: string },
): string {
  const url = new URL(`/api/auth/oauth/${input.provider}/start`, endpoint.baseUrl);
  url.searchParams.set("flow", input.flowId);
  return url.toString();
}
