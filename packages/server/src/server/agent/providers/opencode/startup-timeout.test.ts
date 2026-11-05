import { describe, expect, test } from "vitest";
import { hasArenaDatabaseUpgradeLine, openCodeStartupTimeoutMessage } from "./startup-timeout.js";

describe("engine startup timeout", () => {
  test("names the upgrade limit and tells the user how to resume", () => {
    expect(openCodeStartupTimeoutMessage(true)).toContain("10-minute database upgrade limit");
    expect(openCodeStartupTimeoutMessage(true)).toBe(
      "Arena did not finish starting within the 10-minute database upgrade limit. " +
        "Startup was stopped during database import or cleanup. Start again to resume the upgrade.",
    );
    expect(openCodeStartupTimeoutMessage(false)).toBe("OpenCode server startup timeout");
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
