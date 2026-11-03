import type { KeyObject } from "node:crypto";
import type { AccountUser, SessionMethod } from "./backend.js";
import { verifySessionToken, type VerifiedSessionToken } from "./token.js";

export type SessionResolution =
  | { kind: "authenticated"; user: AccountUser; method: SessionMethod }
  | { kind: "rejected" };

export interface SessionResolverOptions {
  readonly onAuthenticated?: (token: string, user: AccountUser) => void | Promise<void>;
  readonly onForget?: (token: string) => void | Promise<void>;
}

/** Verifies the control plane's 30-day Ed25519 session without network access. */
export class SessionResolver {
  constructor(
    private readonly publicKey: KeyObject,
    private readonly options: SessionResolverOptions = {},
  ) {}

  async resolve(token: string): Promise<SessionResolution> {
    const verified = verifySessionToken(token, this.publicKey);
    if (!verified) return { kind: "rejected" };
    await this.options.onAuthenticated?.(token, verified.user);
    return { kind: "authenticated", user: verified.user, method: verified.method };
  }

  /** Checks a token without treating it as the caller's session. */
  verify(token: string): VerifiedSessionToken | null {
    return verifySessionToken(token, this.publicKey);
  }

  async forget(token: string): Promise<void> {
    await this.options.onForget?.(token);
  }
}
