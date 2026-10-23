import { closeSync, readFileSync } from "node:fs";
import { createVoteEvidenceIssuer } from "@getpaseo/server/arena/vote-evidence";

function inheritedPrivateKey(): string | undefined {
  const descriptor = process.env.PASEO_VOTE_SIGNING_FD;
  delete process.env.PASEO_VOTE_SIGNING_FD;
  if (descriptor !== "3") return undefined;
  try {
    return readFileSync(3, "utf8");
  } finally {
    closeSync(3);
  }
}

// A source build's runner shares its launch key through a one-shot inherited pipe.
// A packaged desktop creates its own issuer before it launches the managed daemon.
export const voteEvidenceIssuer = createVoteEvidenceIssuer({ privateKey: inheritedPrivateKey() });
