#!/usr/bin/env node

import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One Ed25519 pair per checkout signs and verifies local development sessions. Both halves are
// unwrapped base64 DER (PKCS8 private, SPKI public), the format the control plane and daemon parse.

export function devSessionKeysPath(root) {
  return path.join(path.resolve(root), ".dev", "session-keys.json");
}

function generateSessionKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function createKeyFile(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(generateSessionKeys(), null, 2)}\n`, { mode: 0o600 });
  try {
    // link fails when another launcher created the file first, so concurrent starts share one pair.
    linkSync(temporary, file);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
}

function readKeyFile(file) {
  const invalid = new Error(
    `${file} is not a valid session key pair; delete it to generate a new one`,
  );
  try {
    const { privateKey, publicKey } = JSON.parse(readFileSync(file, "utf8"));
    const key = createPrivateKey({
      key: Buffer.from(privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const derived = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
    if (key.asymmetricKeyType === "ed25519" && derived === publicKey) {
      return { privateKey, publicKey };
    }
  } catch {
    // Fall through to the error that names the file without echoing its contents.
  }
  throw invalid;
}

export function ensureDevSessionKeys(root) {
  const file = devSessionKeysPath(root);
  if (!existsSync(file)) createKeyFile(file);
  chmodSync(file, 0o600);
  return readKeyFile(file);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    // Print only the public key; the launcher hands the private key to the control plane itself.
    process.stdout.write(ensureDevSessionKeys(process.argv[2] ?? process.cwd()).publicKey);
  } catch (error) {
    console.error(`[dev-session-keys] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
