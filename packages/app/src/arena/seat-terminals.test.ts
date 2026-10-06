import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildArenaSeatTerminalTarget,
  forgetArenaSeatTerminal,
  getArenaSeatTerminal,
  openArenaSeatTerminal,
  rememberArenaSeatTerminalId,
  useArenaSeatTerminalStore,
} from "./seat-terminals";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

beforeEach(() => {
  useArenaSeatTerminalStore.setState({ byInstanceId: {} });
});

describe("arena seat terminals", () => {
  it("gives every open its own instance and shell", () => {
    const first = openArenaSeatTerminal({ agentId: "agent-1", side: "a" });
    const second = openArenaSeatTerminal({ agentId: "agent-1", side: "a" });

    expect(second).not.toBe(first);
    rememberArenaSeatTerminalId(first, "terminal-1");
    rememberArenaSeatTerminalId(second, "terminal-2");
    expect(getArenaSeatTerminal(first)?.terminalId).toBe("terminal-1");
    expect(getArenaSeatTerminal(second)?.terminalId).toBe("terminal-2");
  });

  it("mints a tab target per open, so the panel's menu and the worktree menu agree", () => {
    const first = buildArenaSeatTerminalTarget({ agentId: "agent-1", side: "a" });
    const second = buildArenaSeatTerminalTarget({ agentId: "agent-1", side: "a" });

    expect(first).toMatchObject({ kind: "arena_terminal", agentId: "agent-1", side: "a" });
    // Two opens are two shells, whichever surface asked for them.
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(getArenaSeatTerminal(first.instanceId)?.ordinal).toBe(1);
    expect(getArenaSeatTerminal(second.instanceId)?.ordinal).toBe(2);
  });

  it("numbers a seat's shells so two tabs can be told apart", () => {
    const first = openArenaSeatTerminal({ agentId: "agent-1", side: "a" });
    const second = openArenaSeatTerminal({ agentId: "agent-1", side: "a" });
    // The other seat counts on its own.
    const otherSide = openArenaSeatTerminal({ agentId: "agent-1", side: "b" });

    expect(getArenaSeatTerminal(first)?.ordinal).toBe(1);
    expect(getArenaSeatTerminal(second)?.ordinal).toBe(2);
    expect(getArenaSeatTerminal(otherSide)?.ordinal).toBe(1);
  });

  it("reuses the number a closed shell gave up", () => {
    const first = openArenaSeatTerminal({ agentId: "agent-1", side: "a" });
    openArenaSeatTerminal({ agentId: "agent-1", side: "a" });
    forgetArenaSeatTerminal(first);

    const replacement = openArenaSeatTerminal({ agentId: "agent-1", side: "a" });
    expect(getArenaSeatTerminal(replacement)?.ordinal).toBe(1);
  });

  it("hands the shell back when the tab closes, and forgets it", () => {
    const instanceId = openArenaSeatTerminal({ agentId: "agent-1", side: "a" });
    rememberArenaSeatTerminalId(instanceId, "terminal-1");

    // The caller kills what it is handed: without the id the shell would outlive its tab.
    expect(forgetArenaSeatTerminal(instanceId)).toBe("terminal-1");
    expect(getArenaSeatTerminal(instanceId)).toBeNull();
    expect(forgetArenaSeatTerminal(instanceId)).toBeNull();
  });
});
