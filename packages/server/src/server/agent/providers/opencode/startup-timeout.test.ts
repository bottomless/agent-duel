import { describe, expect, test } from "vitest";
import { hasArenaDatabaseUpgradeLine, openCodeStartupTimeoutMessage } from "./startup-timeout.js";

describe("engine startup timeout", () => {
  test("names the upgrade limit for backup and import", () => {
    expect(openCodeStartupTimeoutMessage(true)).toContain("10-minute database upgrade limit");
    expect(openCodeStartupTimeoutMessage(true)).toContain("backup, import or cleanup");
    expect(openCodeStartupTimeoutMessage(false)).toBe("OpenCode server startup timeout");
  });

  test("accepts only a complete exact backup line", () => {
    const line = "[arena-upgrade] Backing up databases before OpenCode 2.0";
    expect(hasArenaDatabaseUpgradeLine(line)).toBe(false);
    expect(hasArenaDatabaseUpgradeLine(line + "\n")).toBe(true);
    expect(hasArenaDatabaseUpgradeLine("noise\n" + line + "\r\n")).toBe(true);
    expect(hasArenaDatabaseUpgradeLine("prefix " + line + "\n")).toBe(false);
    expect(hasArenaDatabaseUpgradeLine(line + " extra\n")).toBe(false);
  });
});

test("extends startup for the complete cleanup line, including a retried vacuum", () => {
  const line = "[arena-upgrade] Removing imported OpenCode 1.x tables";
  expect(hasArenaDatabaseUpgradeLine(line)).toBe(false);
  expect(hasArenaDatabaseUpgradeLine(line + "\n")).toBe(true);
  expect(hasArenaDatabaseUpgradeLine("noise\n" + line + "\r\n")).toBe(true);
  expect(hasArenaDatabaseUpgradeLine(line + " extra\n")).toBe(false);
});

test("accepts only the complete exact pending-import line", () => {
  const line = "[arena-upgrade] Importing OpenCode 1.x chats";
  expect(hasArenaDatabaseUpgradeLine(line)).toBe(false);
  expect(hasArenaDatabaseUpgradeLine(line + "\n")).toBe(true);
  expect(hasArenaDatabaseUpgradeLine("noise\n" + line + "\r\n")).toBe(true);
  expect(hasArenaDatabaseUpgradeLine("prefix " + line + "\n")).toBe(false);
  expect(hasArenaDatabaseUpgradeLine(line + " extra\n")).toBe(false);
});
