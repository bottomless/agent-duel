/**
 * The daemon forwards a failed git command whole: the command line it ran, the exit code and
 * signal, then git's own stderr. That is diagnostic output, not something to read under a text
 * field, so the dialog says what happened instead.
 *
 * The one failure a person causes here is naming a branch that already exists, so that becomes
 * a sentence of its own. Anything else keeps git's stderr, which is the part that says
 * something, and drops the preamble.
 */

/** Matches git's own wording. A git translated into another language falls through to stderr. */
const BRANCH_EXISTS = /a branch named '([^']+)' already exists/i;

const COMMAND_FAILED_PREAMBLE = /^Git command failed:.*\(exit code:[^)]*\)\n/;

/** git prefixes its stderr by severity; the label adds nothing once the message is the message. */
const SEVERITY_PREFIX = /^(fatal|error|warning):\s*/i;

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** git's stderr as one sentence, or null when the message is not a git command failure. */
function gitStderrSentence(message: string): string | null {
  if (!COMMAND_FAILED_PREAMBLE.test(message)) return null;
  const stderr = message.replace(COMMAND_FAILED_PREAMBLE, "").trim();
  const firstLine = stderr.split("\n")[0]?.replace(SEVERITY_PREFIX, "").trim();
  return firstLine ? capitalize(firstLine) : null;
}

export function createBranchErrorMessage(
  error: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const existing = BRANCH_EXISTS.exec(message);
  if (existing) {
    return t("workspace.git.actions.createBranch.errors.exists", { branch: existing[1] });
  }
  return gitStderrSentence(message) ?? message;
}
