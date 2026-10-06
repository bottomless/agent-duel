import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { AccountUser, SignInMethod } from "./backend.js";

const ISSUER = "agent-duel-control-plane";
const AUDIENCE = "agent-duel-desktop";
const headerSchema = z.object({ alg: z.literal("EdDSA") });
const claimsSchema = z.object({
  iss: z.literal(ISSUER),
  aud: z.literal(AUDIENCE),
  sub: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  method: z.enum(["email", "google", "github"]),
  iat: z.number(),
  exp: z.number(),
});

export interface VerifiedSessionToken {
  readonly user: AccountUser;
  readonly method: SignInMethod;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function configuredPublicKey(value: string) {
  const trimmed = value.trim();
  if (trimmed.includes("BEGIN")) return createPublicKey(trimmed);
  return createPublicKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "spki" });
}

export function resolveSessionPublicKey(env: NodeJS.ProcessEnv = process.env): KeyObject {
  const configured = env.PASEO_SESSION_PUBLIC_KEY?.trim();
  if (!configured) throw new Error("PASEO_SESSION_PUBLIC_KEY is required");
  return configuredPublicKey(configured);
}

export function verifySessionToken(
  token: string,
  publicKey: KeyObject,
  now: Date = new Date(),
): VerifiedSessionToken | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;
  let parsedHeader: unknown;
  let parsedClaims: unknown;
  try {
    parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString());
    parsedClaims = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (!headerSchema.safeParse(parsedHeader).success) return null;
  const parsed = claimsSchema.safeParse(parsedClaims);
  if (!parsed.success || parsed.data.exp <= Math.floor(now.getTime() / 1000)) return null;
  if (
    !verify(
      null,
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    )
  ) {
    return null;
  }
  const value = parsed.data;
  return {
    user: {
      id: value.sub,
      email: value.email,
      name: value.name,
      image: value.image,
    } satisfies AccountUser,
    method: value.method,
    issuedAt: value.iat,
    expiresAt: value.exp,
  };
}
