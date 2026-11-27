import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AppOpenedRequest } from "@getpaseo/protocol/accounts/schemas";
import { getDesktopHost } from "@/desktop/host";
import { reportAppOpened, type AccountsEndpoint } from "./client";
import type { AccountGate } from "./gate";

// Two local marks feed the anonymous sign-in counts; only first or repeat and whether a session
// was held ever leave the machine. "pending": no earlier build ran on this install and its first
// launch is not reported yet. "1": reported, or an earlier build ran here.
const OPENED_BEFORE_KEY = "agent-duel.app-opened-before";
// "1" once the session store has held a token on this install.
const HELD_SESSION_KEY = "agent-duel.held-session";

interface MarkStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

let launchDecided: Promise<void> | null = null;
let heldSessionWrite: Promise<void> = Promise.resolve();
let reported = false;

/**
 * Settles whether this install still owes its first launch, once per renderer. The account gate
 * calls it when it mounts, not when the report goes out, so a first launch that never reaches
 * accounts keeps its first for a later one.
 */
export function decideInstallLaunch(
  input: { storage?: MarkStorage; installOpenedBefore?: () => Promise<boolean> } = {},
): Promise<void> {
  launchDecided ??= (async () => {
    const storage = input.storage ?? AsyncStorage;
    try {
      if ((await storage.getItem(OPENED_BEFORE_KEY)) !== null) return;
      const openedBefore = input.installOpenedBefore
        ? await input.installOpenedBefore()
        : await getDesktopHost()?.accounts?.installOpenedBefore?.();
      await storage.setItem(OPENED_BEFORE_KEY, openedBefore === true ? "1" : "pending");
    } catch {
      // Left unset, the report reads a repeat, so a failure never inflates first launches.
    }
  })();
  return launchDecided;
}

/** Marks this install as one that has held an account session. Never throws. */
export function markSessionHeld(storage: MarkStorage = AsyncStorage): Promise<void> {
  heldSessionWrite = (async () => {
    try {
      await storage.setItem(HELD_SESSION_KEY, "1");
    } catch {
      // A lost mark only reads this install as new; it must not reach sign-in.
    }
  })();
  return heldSessionWrite;
}

/** Whether this install has held an account session. A storage error reads as false. */
export async function hasHeldSession(storage: MarkStorage = AsyncStorage): Promise<boolean> {
  await heldSessionWrite;
  try {
    return (await storage.getItem(HELD_SESSION_KEY)) === "1";
  } catch {
    return false;
  }
}

async function launchOf(storage: MarkStorage): Promise<AppOpenedRequest["launch"]> {
  try {
    return (await storage.getItem(OPENED_BEFORE_KEY)) === "pending" ? "first" : "repeat";
  } catch {
    return "repeat";
  }
}

/**
 * The session a window load reports, from the screen the person sees, or null for a screen that
 * reports nothing. Accounts must be on: a BYOK daemon reports them off.
 */
export function appOpenedSessionOf(input: {
  gate: AccountGate["kind"];
  accountsEnabled: boolean;
}): AppOpenedRequest["session"] | null {
  if (!input.accountsEnabled) return null;
  if (input.gate === "signed-out") return "signed-out";
  if (input.gate === "signed-in" || input.gate === "acceptance-required") return "signed-in";
  return null;
}

/**
 * Reports this window load to the control plane's anonymous sign-in counts, once per renderer.
 * Every failure is swallowed: the count must never get in the way of opening the app.
 */
export async function reportAppOpenedOnce(input: {
  endpoint: AccountsEndpoint;
  session: AppOpenedRequest["session"];
  storage?: MarkStorage;
  send?: typeof reportAppOpened;
}): Promise<void> {
  if (reported) return;
  reported = true;
  const storage = input.storage ?? AsyncStorage;
  await decideInstallLaunch({ storage });
  const launch = await launchOf(storage);
  const returning = await hasHeldSession(storage);
  const send = input.send ?? reportAppOpened;
  try {
    // Claimed before sending, so a second window loading meanwhile reports a repeat.
    if (launch === "first") await storage.setItem(OPENED_BEFORE_KEY, "1");
    await send(input.endpoint, { session: input.session, launch, returning });
  } catch {
    // A lost report gives the first back to a later load. Opening the app goes on either way.
    if (launch === "first") await storage.setItem(OPENED_BEFORE_KEY, "pending").catch(() => {});
  }
}

export function forgetAppOpenedReportForTests(): void {
  reported = false;
  launchDecided = null;
  heldSessionWrite = Promise.resolve();
}
