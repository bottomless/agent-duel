import { runGitCommand } from "../utils/run-git-command.js";

export interface WorkspaceGitFetchResult {
  changes: WorkspaceGitRemoteRefChange[] | null;
  nonRemoteRefsChanged?: boolean;
  remoteRefs?: ReadonlySet<string>;
  error: unknown | null;
  /** The fetch failed because the remote wants a login the background fetch may not ask for. */
  signInRequired: boolean;
}

export interface WorkspaceGitFetchObserver {
  onRefSnapshot(phase: "before" | "after"): void;
}

export type WorkspaceGitRemoteRefChange =
  | { kind: "moved"; ref: string; beforeOid: string; afterOid: string }
  | { kind: "added"; ref: string; afterOid: string }
  | { kind: "deleted"; ref: string; beforeOid: string };

/**
 * The background fetch runs every few minutes with nobody watching, so it never asks for a login:
 * a credential dialog it opened came back every cycle. A credential helper that already holds a
 * login still answers, since that needs no prompt.
 */
const NON_INTERACTIVE_GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  // Set but empty, Git runs no askpass at all instead of falling back to `core.askPass` or the
  // desktop session's `SSH_ASKPASS`.
  GIT_ASKPASS: "",
  GCM_INTERACTIVE: "never",
  SSH_ASKPASS_REQUIRE: "never",
} as const;

/**
 * Git's own words for a refused login: HTTPS with no stored credentials or wrong ones, an SSH key
 * the server does not accept, and the 401/403 a forge answers with.
 */
const SIGN_IN_FAILURES = [
  /could not read (Username|Password)/i,
  /Authentication failed/i,
  /Permission denied \(publickey/i,
  /Invalid username or password/i,
  /HTTP Basic: Access denied/i,
  /The requested URL returned error: 40[13]/i,
];

export function isSignInFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return SIGN_IN_FAILURES.some((pattern) => pattern.test(message));
}

/** The line where Git says why a command failed, without its `fatal:` or `error:` prefix. */
export function gitFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split("\n").map((line) => line.trim());
  const reason = lines.findLast((line) => /^(fatal|error):/.test(line)) ?? lines[0] ?? message;
  return reason.replace(/^(fatal|error):\s*/, "");
}

export async function fetchWorkspaceGitRemote(
  cwd: string,
  observer: WorkspaceGitFetchObserver,
): Promise<WorkspaceGitFetchResult> {
  let before: Map<string, string> | null = null;
  let after: Map<string, string> | null = null;
  let error: unknown | null = null;
  let signInRequired = false;
  try {
    before = await readWorkspaceGitRefs(cwd);
    observer.onRefSnapshot("before");
  } catch (caught) {
    error = caught;
  }
  try {
    await runGitCommand(["fetch", "origin", "--prune"], {
      cwd,
      envOverlay: NON_INTERACTIVE_GIT_ENV,
      timeout: 120_000,
    });
  } catch (caught) {
    error ??= caught;
    signInRequired = isSignInFailure(caught);
  }
  try {
    after = await readWorkspaceGitRefs(cwd);
  } catch (caught) {
    error ??= caught;
  }
  if (!before || !after) {
    return { changes: null, error, signInRequired };
  }
  const diff = diffWorkspaceGitRefs(before, after);
  const result = {
    changes: diff.remoteChanges,
    nonRemoteRefsChanged: diff.nonRemoteRefsChanged,
    remoteRefs: collectWorkspaceGitRemoteRefs(after),
    error,
    signInRequired,
  } satisfies WorkspaceGitFetchResult;
  observer.onRefSnapshot("after");
  return result;
}

function collectWorkspaceGitRemoteRefs(refs: ReadonlyMap<string, string>): Set<string> {
  const remotePrefix = "refs/remotes/";
  return new Set(
    [...refs.keys()]
      .filter((ref) => ref.startsWith(remotePrefix))
      .map((ref) => ref.slice(remotePrefix.length)),
  );
}

async function readWorkspaceGitRefs(cwd: string): Promise<Map<string, string>> {
  const { stdout } = await runGitCommand(["for-each-ref", "--format=%(refname)%00%(objectname)"], {
    cwd,
  });
  return parseWorkspaceGitRefs(stdout);
}

export function parseWorkspaceGitRefs(stdout: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [ref, objectId] = line.split("\0");
    if (ref?.startsWith("refs/") && objectId) {
      refs.set(ref, objectId);
    }
  }
  return refs;
}

export interface WorkspaceGitRefDiff {
  remoteChanges: WorkspaceGitRemoteRefChange[];
  nonRemoteRefsChanged: boolean;
}

export function diffWorkspaceGitRefs(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): WorkspaceGitRefDiff {
  const remotePrefix = "refs/remotes/";
  const beforeRemote = new Map<string, string>();
  const afterRemote = new Map<string, string>();
  let nonRemoteRefsChanged = false;
  for (const [ref, objectId] of before) {
    if (ref.startsWith(remotePrefix)) {
      beforeRemote.set(ref.slice(remotePrefix.length), objectId);
    } else if (after.get(ref) !== objectId) {
      nonRemoteRefsChanged = true;
    }
  }
  for (const [ref, objectId] of after) {
    if (ref.startsWith(remotePrefix)) {
      afterRemote.set(ref.slice(remotePrefix.length), objectId);
    } else if (!before.has(ref)) {
      nonRemoteRefsChanged = true;
    }
  }
  return {
    remoteChanges: diffWorkspaceGitRemoteRefs(beforeRemote, afterRemote),
    nonRemoteRefsChanged,
  };
}

export function diffWorkspaceGitRemoteRefs(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): WorkspaceGitRemoteRefChange[] {
  const changes: WorkspaceGitRemoteRefChange[] = [];
  for (const [ref, objectId] of after) {
    const beforeOid = before.get(ref);
    if (beforeOid === undefined) {
      changes.push({ kind: "added", ref, afterOid: objectId });
    } else if (beforeOid !== objectId) {
      changes.push({ kind: "moved", ref, beforeOid, afterOid: objectId });
    }
  }
  for (const [ref, beforeOid] of before) {
    if (!after.has(ref)) {
      changes.push({ kind: "deleted", ref, beforeOid });
    }
  }
  return changes;
}
