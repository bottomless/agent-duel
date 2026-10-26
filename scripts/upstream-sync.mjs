#!/usr/bin/env node
// Weekly Paseo intake. `report` lists what upstream shipped since the last sync and sorts it by
// policy; `prepare` also starts the merge and applies the policy's mechanical resolutions, leaving
// only the conflicts that need judgement. Neither commits nor pushes.
//
//   node scripts/upstream-sync.mjs report  [--to upstream/main] [--out <file>]
//   node scripts/upstream-sync.mjs prepare [--to upstream/main] [--out <file>]
//
// `report --from <rev>` previews a range other than the one since the last sync.
//
// Run `prepare` on a fresh branch cut from origin/main. The sync PR must land as a merge commit,
// not a squash: the merge commit is what moves the merge base forward, so next week's merge only
// sees next week's commits.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const rootDir = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const UPSTREAM_REMOTE = "upstream";
const UPSTREAM_URL = "https://github.com/getpaseo/paseo.git";
const UPSTREAM_PR_URL = "https://github.com/getpaseo/paseo/pull/";

// Paseo surfaces Agent Duel removed. Upstream changes here are dropped without review.
const DROP = [
  /^packages\/website\//,
  /^public-docs\//,
  /^fastlane\//,
  /^README\.[a-z-]+\.md$/i,
  /^CHANGELOG\.[a-z-]+\.md$/i,
  /^\.agents\/skills\/release-/,
  /^\.claude\/skills\/release-/,
  /^\.github\/PULL_REQUEST_TEMPLATE\.md$/,
  /^\.github\/ci-paths\.yml$/,
  /^\.github\/workflows\/(?!ci\.yml$|desktop-release\.yml$)/,
  /^docs\/(android|hub|mobile-testing|product|protocol-compatibility|release|website-i18n)\.md$/,
  /^docs\/qa-evidence\//,
  /^packages\/app\/\.eas\//,
  /^packages\/app\/eas\.json$/,
  /^packages\/app\/native-release-version/,
  /^packages\/app\/plugins\//,
  /^packages\/app\/app\.config\.test\.ts$/,
  /^packages\/desktop\/assets\/icon-dev\.png$/,
  /^packages\/desktop\/src\/features\/browser-capture/,
  /^packages\/app\/src\/desktop\/browser\/pane\/element-selector/,
  /^packages\/app\/src\/changelog\//,
  /^packages\/app\/src\/fdroid\//,
  /^packages\/app\/src\/hosts\//,
  /^packages\/app\/src\/schedules\//,
  /^packages\/app\/src\/components\/schedules\//,
  /^packages\/app\/src\/components\/hosts\//,
  /^packages\/app\/src\/diagnostics\//,
  /^packages\/app\/e2e\/browser\/schedules-/,
  /^packages\/cli\/src\/commands\/(hub|schedule|heartbeat)\//,
  /^packages\/cli\/tests\/\d+-(schedule|hub)/,
  /^packages\/protocol\/src\/schedule\//,
  /^packages\/server\/src\/server\/hub\//,
  /^packages\/server\/src\/server\/schedule\//,
  /^scripts\/(sync-fdroid-changelogs|build-apk|test-mobile-agent-device|seed-ios-native-cache|paseo-ios-simulator-service)/,
];

// Files Agent Duel owns outright. Upstream edits to them are reported, never merged.
const OURS = new Set([
  "LICENSE",
  "NOTICE",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "README.md",
  ".github/workflows/ci.yml",
  ".github/workflows/desktop-release.yml",
  "packages/app/app.config.js",
  "packages/server/CLAUDE.md",
  "docs/arena.md",
  "docs/accounts.md",
  "docs/side-panel.md",
  "docs/qa.md",
  "docs/deployment.md",
]);

// Areas where Agent Duel's product or the battle engine meets upstream code. A change here is
// merged, but it needs a reviewer's eye and, usually, a check in the running app.
const REVIEW = [
  {
    label: "Battle bridge (providers, session, protocol)",
    pattern:
      /^packages\/(server\/src\/server\/(agent\/providers\/opencode|session|websocket-server|bootstrap)|protocol\/src\/messages|client\/src\/daemon-client)/,
  },
  { label: "Desktop shell (Electron main, daemon, updates)", pattern: /^packages\/desktop\// },
  {
    label: "Workspace layout and sidebar",
    pattern:
      /^packages\/app\/src\/(components\/(left-sidebar|sidebar|split-container)|screens\/workspace|workspace-tabs|panels|stores\/workspace-layout)/,
  },
  {
    label: "New chat and composer",
    pattern: /^packages\/app\/src\/(screens\/new-workspace|composer)/,
  },
  { label: "Settings", pattern: /^packages\/app\/src\/screens\/settings/ },
  { label: "Dependencies", pattern: /(^|\/)package\.json$/ },
];

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  }).trimEnd();
}

function tryGit(args) {
  try {
    return { ok: true, out: git(args, { stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function lines(text) {
  return text.split("\n").filter(Boolean);
}

function isDropped(file) {
  return DROP.some((pattern) => pattern.test(file));
}

function reviewLabel(file) {
  return REVIEW.find((entry) => entry.pattern.test(file))?.label;
}

function parseArgs(argv) {
  const [command = "report", ...rest] = argv;
  const options = { command, to: `${UPSTREAM_REMOTE}/main`, from: null, out: null };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--to") options.to = rest[++i];
    else if (rest[i] === "--out") options.out = rest[++i];
    else if (rest[i] === "--from") options.from = rest[++i];
    else throw new Error(`Unknown argument ${rest[i]}`);
  }
  if (options.from && options.command !== "report") {
    throw new Error("--from only applies to report");
  }
  if (!["report", "prepare"].includes(options.command)) {
    throw new Error(`Unknown command ${options.command}; use report or prepare`);
  }
  return options;
}

function ensureUpstream() {
  if (!lines(git(["remote"])).includes(UPSTREAM_REMOTE)) {
    git(["remote", "add", UPSTREAM_REMOTE, UPSTREAM_URL]);
    git([
      "config",
      `remote.${UPSTREAM_REMOTE}.fetch`,
      `+refs/heads/main:refs/remotes/${UPSTREAM_REMOTE}/main`,
    ]);
    git(["config", `remote.${UPSTREAM_REMOTE}.tagOpt`, "--no-tags"]);
  }
  git(["fetch", UPSTREAM_REMOTE], { stdio: ["ignore", "pipe", "inherit"] });
}

function collectCommits(base, to) {
  const format = "%H%x1f%h%x1f%ad%x1f%s";
  return lines(
    git([
      "log",
      "--reverse",
      "--no-merges",
      `--format=${format}`,
      "--date=short",
      `${base}..${to}`,
    ]),
  ).map((line) => {
    const [sha, short, date, subject] = line.split("\x1f");
    const files = lines(git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]));
    const pr = subject.match(/\(#(\d+)\)\s*$/)?.[1] ?? null;
    return { sha, short, date, subject, files, pr };
  });
}

// Upstream's own release bookkeeping; Agent Duel versions and releases separately.
const RELEASE_BOOKKEEPING =
  /^(chore\(release\)|fix: update lockfile signatures|chore: update nix hash)/i;

function classify(commit) {
  if (RELEASE_BOOKKEEPING.test(commit.subject)) return { bucket: "drop", labels: [] };
  const kept = commit.files.filter((file) => !isDropped(file));
  if (kept.length === 0) return { bucket: "drop", labels: [] };
  const owned = kept.filter((file) => OURS.has(file));
  if (owned.length === kept.length) return { bucket: "ours", labels: [] };
  const labels = [...new Set(kept.map(reviewLabel).filter(Boolean))];
  return { bucket: labels.length > 0 ? "review" : "take", labels };
}

function commitLine(commit) {
  const link = commit.pr ? ` ([#${commit.pr}](${UPSTREAM_PR_URL}${commit.pr}))` : "";
  return `- ${commit.date} \`${commit.short}\` ${commit.subject.replace(/\s*\(#\d+\)\s*$/, "")}${link}`;
}

function applyPolicy() {
  const resolved = { dropped: [], ours: [] };
  const status = lines(git(["status", "--porcelain", "--untracked-files=no"]));
  for (const entry of status) {
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    const unmerged = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code);
    if (isDropped(file) && code !== "D " && code !== " D") {
      git(["rm", "-q", "-f", "--", file]);
      resolved.dropped.push(file);
    } else if (unmerged && OURS.has(file)) {
      git(["checkout", "--ours", "--", file]);
      git(["add", "--", file]);
      resolved.ours.push(file);
    } else if (unmerged && code === "DU") {
      // Agent Duel deleted it and upstream kept editing it: the deletion stands.
      git(["rm", "-q", "-f", "--", file]);
      resolved.dropped.push(file);
    }
  }
  return resolved;
}

function conflictSizes() {
  return lines(git(["diff", "--name-only", "--diff-filter=U"])).map((file) => {
    let hunks = 0;
    try {
      hunks = (readFileSync(path.join(rootDir, file), "utf8").match(/^<<<<<<< /gm) ?? []).length;
    } catch {
      // A modify/delete conflict has no working file to count.
    }
    return { file, hunks, review: reviewLabel(file) };
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureUpstream();
  const base = options.from
    ? git(["rev-parse", options.from])
    : git(["merge-base", "HEAD", options.to]);
  const head = git(["rev-parse", "--short", options.to]);
  const commits = collectCommits(base, options.to);
  const buckets = { review: [], take: [], ours: [], drop: [] };
  for (const commit of commits) {
    Object.assign(commit, classify(commit));
    buckets[commit.bucket].push(commit);
  }

  const report = [];
  report.push(`# Paseo intake: ${base.slice(0, 9)}..${head}`, "");
  report.push(
    `${commits.length} upstream commits. Review ${buckets.review.length}, take ${buckets.take.length}, Agent Duel-owned ${buckets.ours.length}, dropped ${buckets.drop.length}.`,
    "",
  );

  if (options.command === "prepare") {
    git(["fetch", "origin", "main"], { stdio: ["ignore", "pipe", "inherit"] });
    if (!tryGit(["merge-base", "--is-ancestor", "origin/main", "HEAD"]).ok) {
      throw new Error(
        "HEAD does not contain origin/main; cut the sync branch from the current origin/main",
      );
    }
    git(["config", "merge.conflictStyle", "zdiff3"]);
    git(["config", "rerere.enabled", "true"]);
    git(["config", "merge.renameLimit", "20000"]);
    const merge = tryGit(["merge", "--no-ff", "--no-commit", options.to]);
    const resolved = applyPolicy();
    const conflicts = conflictSizes();
    report.push("## Merge", "");
    report.push(
      merge.ok
        ? "Merged without conflicts."
        : `${conflicts.length} files still conflict after the policy (${resolved.dropped.length} dropped, ${resolved.ours.length} kept as ours).`,
      "",
    );
    if (conflicts.length > 0) {
      report.push("| File | Hunks | Review area |", "| --- | --- | --- |");
      for (const conflict of conflicts.sort((a, b) => b.hunks - a.hunks)) {
        report.push(`| \`${conflict.file}\` | ${conflict.hunks} | ${conflict.review ?? ""} |`);
      }
      report.push("");
    }
    report.push(
      "Then: regenerate `package-lock.json` (`node scripts/sync-workspace-versions.mjs && npm install`), `npm run build:server`, `npm run typecheck`, `npm run lint`, and check a stubbed battle in Electron.",
      "",
    );
  }

  report.push("## Needs review", "");
  const byLabel = new Map();
  for (const commit of buckets.review) {
    for (const label of commit.labels) {
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(commit);
    }
  }
  for (const [label, list] of byLabel) {
    report.push(`### ${label}`, "", ...list.map(commitLine), "");
  }
  report.push("## Taken as is", "", ...buckets.take.map(commitLine), "");
  report.push(
    "## Touches only Agent Duel-owned files (not merged)",
    "",
    ...buckets.ours.map(commitLine),
    "",
  );
  report.push("## Dropped (removed surfaces)", "", ...buckets.drop.map(commitLine), "");

  const text = `${report.join("\n")}\n`;
  if (options.out) writeFileSync(options.out, text);
  else process.stdout.write(text);
}

main();
