import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveSessionPublicKey, verifySessionToken } from "./token.js";

const keys = generateKeyPairSync("ed25519");
const sessionPublicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

function token(expiresAt: number) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "agent-duel-control-plane",
      aud: "agent-duel-desktop",
      sub: "user-1",
      email: "dev@example.com",
      name: null,
      image: null,
      method: "email",
      iat: 1_700_000_000,
      exp: expiresAt,
    }),
  ).toString("base64url");
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url")}`;
}

/** The last base64url character carries padding bits, so tamper with the first signature byte. */
function tampered(value: string) {
  const signatureStart = value.lastIndexOf(".") + 1;
  const replacement = value[signatureStart] === "A" ? "B" : "A";
  return `${value.slice(0, signatureStart)}${replacement}${value.slice(signatureStart + 1)}`;
}

describe("desktop session verification", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const publicKey = resolveSessionPublicKey({ PASEO_SESSION_PUBLIC_KEY: sessionPublicKey });

  it("accepts a valid control-plane token without a network lookup", () => {
    const expiresAt = Math.floor(now.getTime() / 1000) + 60;
    expect(verifySessionToken(token(expiresAt), publicKey, now)?.user.id).toBe("user-1");
  });

  it("rejects expired and tampered tokens", () => {
    const expiresAt = Math.floor(now.getTime() / 1000) - 1;
    expect(verifySessionToken(token(expiresAt), publicKey, now)).toBeNull();

    const valid = token(Math.floor(now.getTime() / 1000) + 60);
    expect(verifySessionToken(tampered(valid), publicKey, now)).toBeNull();
  });

  it("rejects a token signed by another key", () => {
    const otherKey = generateKeyPairSync("ed25519").publicKey;
    const valid = token(Math.floor(now.getTime() / 1000) + 60);
    expect(verifySessionToken(valid, otherKey, now)).toBeNull();
  });

  it.each(["development", "production"])("requires a configured public key in %s", (mode) => {
    expect(() => resolveSessionPublicKey({ PASEO_NODE_ENV: mode })).toThrow(
      "PASEO_SESSION_PUBLIC_KEY is required",
    );
  });
});
