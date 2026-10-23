import { describe, expect, it } from "vitest";
import type { ArenaVoteTarget } from "@getpaseo/protocol/arena/rpc-schemas";
import { createVoteEvidenceIssuer, createVoteEvidenceVerifier } from "./vote-evidence.js";

const target: ArenaVoteTarget = {
  kind: "battle",
  agentId: "agent-1",
  targetId: "turn-1",
  vote: "a",
};

function fixture() {
  let time = 100_000;
  const now = () => time;
  const issuer = createVoteEvidenceIssuer({ now });
  const verifier = createVoteEvidenceVerifier({ publicKey: issuer.publicKey, now });
  return {
    issuer,
    verifier,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("vote input evidence", () => {
  it("refuses caller-supplied native and injected labels without proof", () => {
    const { verifier } = fixture();
    expect(verifier.consume(target, "native")).toBe("unverified");
    expect(verifier.consume(target, "injected")).toBe("unverified");
    expect(verifier.consume(target, "api")).toBe("api");
    expect(verifier.consume(target, "synthetic")).toBe("synthetic");
  });

  it("accepts a launch-trusted desktop receipt once across callers", () => {
    const { issuer, verifier } = fixture();
    const evidence = issuer.issue(target, "native");
    expect(verifier.consume(target, evidence.source, evidence.receipt)).toBe("native");
    expect(verifier.consume(target, evidence.source, evidence.receipt)).toBe("unverified");
  });

  it("cannot replay proof by changing its base64 encoding", () => {
    const { issuer, verifier } = fixture();
    const evidence = issuer.issue(target, "native");
    if (!evidence.receipt) throw new Error("Issuer did not supply evidence");
    expect(verifier.consume(target, "native", evidence.receipt)).toBe("native");
    const reencoded = {
      payload: Buffer.from(evidence.receipt.payload, "base64url").toString("base64"),
      signature: Buffer.from(evidence.receipt.signature, "base64url").toString("base64"),
    };
    expect(verifier.consume(target, "native", reencoded)).toBe("unverified");
  });

  it("does not evict consumed proof when an attacker fills the replay cache", () => {
    const { issuer, verifier, advance } = fixture();
    const first = issuer.issue(target, "native");
    expect(verifier.consume(target, first.source, first.receipt)).toBe("native");
    for (let index = 1; index < 4096; index++) {
      const evidence = issuer.issue(target, "native");
      expect(verifier.consume(target, evidence.source, evidence.receipt)).toBe("native");
    }
    const overflow = issuer.issue(target, "native");
    expect(verifier.consume(target, overflow.source, overflow.receipt)).toBe("unverified");
    expect(verifier.consume(target, first.source, first.receipt)).toBe("unverified");
    advance(60_001);
    const fresh = issuer.issue(target, "native");
    expect(verifier.consume(target, fresh.source, fresh.receipt)).toBe("native");
    expect(verifier.consume(target, first.source, first.receipt)).toBe("unverified");
  });

  it("cannot crowd out OS evidence with renderer-only receipts", () => {
    const { issuer, verifier } = fixture();
    for (let index = 0; index < 4096; index++) {
      const evidence = issuer.issue(target, "unverified");
      expect(verifier.consume(target, evidence.source, evidence.receipt)).toBe("unverified");
    }
    const native = issuer.issue(target, "native");
    expect(verifier.consume(target, native.source, native.receipt)).toBe("native");
    expect(verifier.consume(target, native.source, native.receipt)).toBe("unverified");
  });

  it("refuses a replacement issuer supplied by the attacker", () => {
    const { verifier } = fixture();
    const attacker = createVoteEvidenceIssuer();
    const forged = attacker.issue(target, "native");
    expect(verifier.consume(target, forged.source, forged.receipt)).toBe("unverified");
    expect(createVoteEvidenceVerifier().consume(target, forged.source, forged.receipt)).toBe(
      "unverified",
    );
  });

  it("binds evidence to the exact agent, turn, choice, and source", () => {
    const { issuer, verifier } = fixture();
    const evidence = issuer.issue(target, "injected");
    expect(
      verifier.consume({ ...target, agentId: "agent-2" }, evidence.source, evidence.receipt),
    ).toBe("unverified");
    expect(
      verifier.consume({ ...target, targetId: "turn-2" }, evidence.source, evidence.receipt),
    ).toBe("unverified");
    expect(verifier.consume({ ...target, vote: "b" }, evidence.source, evidence.receipt)).toBe(
      "unverified",
    );
    expect(verifier.consume(target, "native", evidence.receipt)).toBe("unverified");
    expect(verifier.consume(target, "injected", evidence.receipt)).toBe("injected");
  });

  it("cannot transfer battle evidence to a single-agent rating", () => {
    const { issuer, verifier } = fixture();
    const evidence = issuer.issue(target, "native");
    const rating: ArenaVoteTarget = {
      kind: "single_agent",
      agentId: "agent-1",
      targetId: "rating-1",
      vote: "up",
    };
    expect(verifier.consume(rating, evidence.source, evidence.receipt)).toBe("unverified");
    const singleEvidence = issuer.issue(rating, "native");
    expect(verifier.consume(rating, singleEvidence.source, singleEvidence.receipt)).toBe("native");
  });

  it("refuses modified payloads and signatures", () => {
    const { issuer, verifier } = fixture();
    const evidence = issuer.issue(target, "native");
    if (!evidence.receipt) throw new Error("Issuer did not supply evidence");
    const payload = Buffer.from(JSON.stringify({ source: "native", target })).toString("base64url");
    expect(verifier.consume(target, "native", { ...evidence.receipt, payload })).toBe("unverified");
    expect(verifier.consume(target, "native", { ...evidence.receipt, signature: "invalid" })).toBe(
      "unverified",
    );
  });

  it("expires receipts and refuses future-dated proof", () => {
    const { issuer, verifier, advance } = fixture();
    const evidence = issuer.issue(target, "native");
    advance(-2000);
    expect(verifier.consume(target, "native", evidence.receipt)).toBe("unverified");
    advance(62_001);
    expect(verifier.consume(target, "native", evidence.receipt)).toBe("unverified");
  });
});
