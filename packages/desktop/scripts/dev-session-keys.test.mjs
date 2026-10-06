import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { devSessionKeysPath, ensureDevSessionKeys } from "./dev-session-keys.mjs";

describe("desktop development session keys", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "dev-session-keys-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("creates a private Ed25519 pair in unwrapped base64 DER", () => {
    const keys = ensureDevSessionKeys(root);
    const file = devSessionKeysPath(root);

    expect(file).toBe(path.join(root, ".dev", "session-keys.json"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const privateKey = createPrivateKey({
      key: Buffer.from(keys.privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey({
      key: Buffer.from(keys.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    const signature = sign(null, Buffer.from("session"), privateKey);
    expect(verify(null, Buffer.from("session"), publicKey, signature)).toBe(true);
  });

  test("reuses the checkout's pair and restores owner-only permissions", () => {
    const first = ensureDevSessionKeys(root);
    chmodSync(devSessionKeysPath(root), 0o644);

    expect(ensureDevSessionKeys(root)).toEqual(first);
    expect(statSync(devSessionKeysPath(root)).mode & 0o777).toBe(0o600);
  });

  test("rejects a file whose halves do not match without echoing it", () => {
    const keys = ensureDevSessionKeys(root);
    const other = mkdtempSync(path.join(tmpdir(), "dev-session-keys-other-"));
    try {
      const mismatched = { ...keys, publicKey: ensureDevSessionKeys(other).publicKey };
      writeFileSync(devSessionKeysPath(root), JSON.stringify(mismatched));

      let message = "";
      try {
        ensureDevSessionKeys(root);
      } catch (error) {
        message = error.message;
      }
      expect(message).toMatch(/not a valid session key pair/);
      expect(message).not.toContain(keys.privateKey);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("rejects a file that is not JSON", () => {
    mkdirSync(path.dirname(devSessionKeysPath(root)), { recursive: true });
    writeFileSync(devSessionKeysPath(root), "not json");

    expect(() => ensureDevSessionKeys(root)).toThrow(/delete it to generate a new one/);
  });
});
