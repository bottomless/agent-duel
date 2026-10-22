import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import {
  ArenaVoteReceiptSchema,
  ArenaVoteSourceSchema,
  ArenaVoteTargetSchema,
  type ArenaVoteEvidence,
  type ArenaVoteReceipt,
  type ArenaVoteSource,
  type ArenaVoteTarget,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { z } from "zod";

const RECEIPT_LIFETIME_MS = 60_000;
const MAX_CONSUMED_RECEIPTS = 4096;
const ReceiptPayloadSchema = z.object({
  version: z.literal(1),
  nonce: z.uuid(),
  issuedAt: z.number().int().nonnegative(),
  target: ArenaVoteTargetSchema,
  source: ArenaVoteSourceSchema,
});

export interface VoteEvidenceIssuer {
  publicKey: string;
  issue(target: ArenaVoteTarget, source: ArenaVoteSource): ArenaVoteEvidence;
}

interface VoteEvidenceIssuerOptions {
  privateKey?: string;
  now?: () => number;
}

export function createVoteEvidenceIssuer(
  options: VoteEvidenceIssuerOptions = {},
): VoteEvidenceIssuer {
  const privateKey = options.privateKey
    ? createPrivateKey({
        key: Buffer.from(options.privateKey, "base64"),
        format: "der",
        type: "pkcs8",
      })
    : generateKeyPairSync("ed25519").privateKey;
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const now = options.now ?? Date.now;
  return {
    publicKey,
    issue(target, source) {
      const payload = Buffer.from(
        JSON.stringify({ version: 1, nonce: randomUUID(), issuedAt: now(), target, source }),
      );
      return {
        source,
        receipt: {
          payload: payload.toString("base64url"),
          signature: sign(null, payload, privateKey).toString("base64url"),
        },
      };
    },
  };
}

export interface VoteEvidenceVerifier {
  consume(
    target: ArenaVoteTarget,
    source: ArenaVoteSource,
    receipt?: ArenaVoteReceipt,
  ): ArenaVoteSource;
}

interface VoteEvidenceVerifierOptions {
  publicKey?: string;
  now?: () => number;
}

function matchesTarget(signed: ArenaVoteTarget, target: ArenaVoteTarget): boolean {
  return (
    signed.kind === target.kind &&
    signed.agentId === target.agentId &&
    signed.targetId === target.targetId &&
    signed.vote === target.vote
  );
}

/** The launch-configured key is never registered or replaced through a client RPC. */
export function createVoteEvidenceVerifier(
  options: VoteEvidenceVerifierOptions = {},
): VoteEvidenceVerifier {
  const publicKey = options.publicKey
    ? createPublicKey({
        key: Buffer.from(options.publicKey, "base64"),
        format: "der",
        type: "spki",
      })
    : null;
  const now = options.now ?? Date.now;
  const consumed = new Map<string, number>();

  function consume(
    target: ArenaVoteTarget,
    source: ArenaVoteSource,
    receipt?: ArenaVoteReceipt,
  ): ArenaVoteSource {
    const claimedOsInput = source === "native" || source === "injected";
    const fallback = claimedOsInput || receipt ? "unverified" : source;
    if (!publicKey || !receipt) return fallback;
    const envelope = ArenaVoteReceiptSchema.safeParse(receipt);
    if (!envelope.success) return fallback;
    const payload = Buffer.from(envelope.data.payload, "base64url");
    const signature = Buffer.from(envelope.data.signature, "base64url");
    if (signature.length !== 64 || !verify(null, payload, publicKey, signature))
      return "unverified";
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload.toString("utf8"));
    } catch {
      return "unverified";
    }
    const parsed = ReceiptPayloadSchema.safeParse(decoded);
    if (!parsed.success) return "unverified";
    const signed = parsed.data;
    if (!matchesTarget(signed.target, target) || signed.source !== source) return "unverified";
    const time = now();
    if (signed.issuedAt > time + 1000 || time - signed.issuedAt > RECEIPT_LIFETIME_MS)
      return "unverified";
    for (const [nonce, expiresAt] of consumed) {
      if (expiresAt < time) consumed.delete(nonce);
    }
    if (consumed.has(signed.nonce) || consumed.size >= MAX_CONSUMED_RECEIPTS) return "unverified";
    consumed.set(signed.nonce, signed.issuedAt + RECEIPT_LIFETIME_MS);
    return signed.source;
  }

  return { consume };
}
