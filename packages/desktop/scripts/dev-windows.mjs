#!/usr/bin/env node
// Runs dev.sh under Git Bash. npm starts scripts in cmd.exe, which cannot run a shell script, and
// `bash` on PATH may be WSL's. Git Bash converts the POSIX paths dev.sh exports into `C:/` paths
// for the Node processes it starts.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function gitBash() {
  if (process.env.OPENCODE_GIT_BASH_PATH) return process.env.OPENCODE_GIT_BASH_PATH;
  const found = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
  for (const git of found.stdout.split(/\r?\n/).filter(Boolean)) {
    // `git.exe` sits in `cmd\`, `bin\` or `mingw64\bin\` of the install.
    const bash = [
      path.join(git, "..", "..", "bin", "bash.exe"),
      path.join(git, "..", "bash.exe"),
      path.join(git, "..", "..", "..", "bin", "bash.exe"),
    ].find((candidate) => existsSync(candidate));
    if (bash) return bash;
  }
  return undefined;
}

const bash = gitBash();
if (!bash) {
  console.error(
    "Git Bash was not found. Install Git for Windows, or set OPENCODE_GIT_BASH_PATH to its bash.exe.",
  );
  process.exit(1);
}
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "dev.sh");
const child = spawn(bash, [script, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
