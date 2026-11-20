#!/usr/bin/env bash
# Cleanup after a weekly OpenCode sync merge into arena-backend/ (docs/upstream-sync.md).
#
# Run from the repository root while `git merge -X subtree=arena-backend -X no-renames <tag>` is
# stopped on conflicts (or after it finished cleanly, before the merge is committed).
#
# 1. Removes every path under arena-backend/ that is outside the keep-list: leaked new files in
#    packages we don't ship, modify/delete and rename/delete conflicts there, and new upstream
#    packages. Kept-path conflicts are left alone.
# 2. Prints what it removed that was not already on the known-removed list, so a new upstream
#    package or root file gets a decision instead of a silent drop.
# 3. Prints the remaining unmerged paths by type, and kept package.json files that point at a
#    workspace package we don't ship.
#
# Usage: opencode-sync-cleanup.sh [--dry-run]
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

AB=arena-backend
[[ -d "$AB" ]] || {
  echo "Run this from the repository root." >&2
  exit 1
}

# What we keep from upstream OpenCode, relative to arena-backend/. Our own packages
# (arena-service, effect-sqlite-node, llm, opencode, sdk/js) are listed so the rule never drops them.
KEEP_RE='^arena-backend/('
KEEP_RE+='\.editorconfig|\.gitattributes|\.gitignore|\.oxlintrc\.json|\.prettierignore|'
KEEP_RE+='AGENTS\.md|CONTEXT\.md|LICENSE|README\.md|bun\.lock|bunfig\.toml|package\.json|tsconfig\.json|turbo\.json|'
KEEP_RE+='patches/.*|script/.*|'
KEEP_RE+='packages/(ai|arena-service|client|codemode|core|effect-drizzle-sqlite|effect-sqlite-node|http-recorder|httpapi-codegen|llm|opencode|plugin|plugin-browser|protocol|schema|script|server|simulation|util)/.*|'
KEEP_RE+='packages/sdk/js/.*'
KEEP_RE+=')$'

# Files inside kept paths that we removed on purpose.
DROP_RE='^arena-backend/packages/plugin/src/effect/PLAN\.md$'

# Upstream paths we already decided not to ship (through v2.3.2). A removed path outside this list
# is new upstream and gets reported.
KNOWN_REMOVED_RE='^arena-backend/('
KNOWN_REMOVED_RE+='\.dockerignore|\.github/.*|\.gitleaksignore|\.husky/.*|\.opencode/.*|\.vscode/.*|\.zed/.*|'
KNOWN_REMOVED_RE+='CHANGELOG\.md|CONTRIBUTING\.md|README\.[a-z]+\.md|SECURITY\.md|STATS\.md|V2_HTTP_API_AUDIT\.md|'
KNOWN_REMOVED_RE+='flake\.lock|flake\.nix|github/.*|infra/.*|install|nix/.*|perf/.*|salesforce/.*|screenshot-uk\.png|'
KNOWN_REMOVED_RE+='sdks/.*|services/.*|specs/.*|sst-env\.d\.ts|sst\.config\.ts|'
KNOWN_REMOVED_RE+='packages/(app|cli|console|containers|data|desktop|function|gui-extensions|gui-plugins|identity|latex|merman|nav-menus|patchmark|plugins|posts|process-daemon|session-ui|stats|stories|storybook|theme|tui|ui|web)/.*|'
KNOWN_REMOVED_RE+='packages/sdk/(README\.md|package\.json|script/.*|src/.*|sst-env\.d\.ts|test/.*|tsconfig\.build\.json|tsconfig\.json)'
KNOWN_REMOVED_RE+=')$'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Every path git knows under arena-backend/, staged or unmerged, plus untracked files the merge left.
{
  git ls-files -z --cached -- "$AB/"
  git ls-files -z --others --exclude-standard -- "$AB/"
} | tr '\0' '\n' | sort -u >"$tmp/all"

grep -Ev "$KEEP_RE" "$tmp/all" >"$tmp/drop" || true
grep -E "$DROP_RE" "$tmp/all" >>"$tmp/drop" || true
sort -u -o "$tmp/drop" "$tmp/drop"
grep -Ev "$KNOWN_REMOVED_RE" "$tmp/drop" | grep -Ev "$DROP_RE" >"$tmp/new-drop" || true

echo "Removing $(wc -l <"$tmp/drop" | tr -d ' ') paths outside the keep-list."
if [[ -s "$tmp/new-drop" ]]; then
  echo "Not on the known-removed list (new upstream paths, decide whether to keep them):"
  sed -E 's#^arena-backend/(packages/[^/]+|[^/]+).*#  \1#' "$tmp/new-drop" | sort | uniq -c
fi
if [[ $DRY_RUN -eq 0 && -s "$tmp/drop" ]]; then
  tr '\n' '\0' <"$tmp/drop" | xargs -0 -n 500 git rm -q -f --cached --ignore-unmatch --
  tr '\n' '\0' <"$tmp/drop" | xargs -0 -n 500 rm -f --
  find "$AB" -type d -empty -delete 2>/dev/null || true
fi

# Upstream bumps package versions only on the release branch, so every tag conflicts on the
# "version" line of each package.json. Give all three sides upstream's version line and merge
# again; if that merges cleanly, the version line was the only conflict and our other edits stay.
echo
echo "package.json conflicts on the version line only (resolved with upstream's version):"
n=0
for pj in $(git ls-files -u -- "$AB/package.json" "$AB/packages/*/package.json" | awk -F'\t' '{print $2}' | sort -u); do
  git show ":1:$pj" >"$tmp/base" 2>/dev/null || continue
  git show ":2:$pj" >"$tmp/ours" 2>/dev/null || continue
  git show ":3:$pj" >"$tmp/theirs" 2>/dev/null || continue
  v=$(grep -m1 '^  "version": ' "$tmp/theirs" || true)
  [[ -n "$v" ]] || continue
  for side in base ours; do
    python3 -I -c 'import re,sys; p,v=sys.argv[1],sys.argv[2]; t=open(p).read(); open(p,"w").write(re.sub(r"^  \"version\": .*$", v, t, count=1, flags=re.M))' "$tmp/$side" "$v"
  done
  if git merge-file -p "$tmp/ours" "$tmp/base" "$tmp/theirs" >"$tmp/merged" 2>/dev/null; then
    n=$((n + 1))
    echo "  $pj"
    if [[ $DRY_RUN -eq 0 ]]; then
      cp "$tmp/merged" "$pj" && git add -- "$pj"
    fi
  fi
done
[[ $n -gt 0 ]] || echo "  none"

echo
echo "Unmerged paths left (all in kept paths):"
git ls-files -z -u -- "$AB/" | tr '\0' '\n' | awk -F'\t' '{split($1,m," "); s[$2]=s[$2] m[3]} END{for (p in s) print s[p]"\t"p}' |
  awk -F'\t' '{
    st=$1; t="other(" st ")";
    if (st ~ /1/ && st ~ /2/ && st ~ /3/) t="content";
    else if (st ~ /1/ && st ~ /3/) t="deleted-by-us/changed-upstream";
    else if (st ~ /1/ && st ~ /2/) t="changed-by-us/deleted-upstream";
    else if (st ~ /2/ && st ~ /3/) t="add/add";
    else if (st == "3") t="added-upstream-unmerged";
    print t"\t"$2 }' | sort | tee "$tmp/left" | sed 's/^/  /'
[[ -s "$tmp/left" ]] || echo "  none"

echo
echo "Workspace packages that depend on a workspace package we don't ship:"
python3 -I - "$AB" <<'PY'
import glob, json, os, sys

ab = sys.argv[1]
try:
    root = json.load(open(os.path.join(ab, "package.json")))
except Exception:
    print("  root package.json is still conflicted; resolve it and rerun")
    sys.exit(0)
ws = root.get("workspaces", [])
patterns = ws.get("packages", []) if isinstance(ws, dict) else ws
dirs = sorted({d for p in patterns for d in glob.glob(os.path.join(ab, p)) if os.path.isfile(os.path.join(d, "package.json"))})
pkgs = {}
for d in dirs:
    try:
        pkgs[d] = json.load(open(os.path.join(d, "package.json")))
    except Exception:
        print(f"  {d}/package.json is still conflicted")
names = {p.get("name") for p in pkgs.values()}
missing = 0
for d, p in pkgs.items():
    optional_peers = {n for n, m in (p.get("peerDependenciesMeta") or {}).items() if m.get("optional")}
    for k in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        for n, v in (p.get(k) or {}).items():
            if k == "peerDependencies" and n in optional_peers:
                continue
            if str(v).startswith("workspace:") and n not in names:
                print(f"  {d} -> {n}")
                missing += 1
if not missing:
    print("  none")
PY
