import { describe, expect, it } from "vitest";
import { summarizeShellCommand } from "./shell-command-summary";

const UPLOAD_ID = "upload_00000000-0000-4000-8000-000000000000";
const UPLOAD_DIR = `/home/user/.paseo/uploads/${UPLOAD_ID}`;
const WORKTREE = "/repo/.agent-duel/worktrees/turn/generation-1-a";

describe("summarizeShellCommand", () => {
  it("leaves a command that already reads well without a summary", () => {
    expect(summarizeShellCommand("git status --short", WORKTREE)).toBeUndefined();
    expect(summarizeShellCommand("node -e \"console.log('hi')\"", WORKTREE)).toBeUndefined();
  });

  it("ignores an uploads folder that belongs to the project", () => {
    expect(summarizeShellCommand("ls public/uploads/upload_1/avatar.png")).toBeUndefined();
  });

  describe("paths", () => {
    it("shortens an upload path to its file name, without quotes it no longer needs", () => {
      const command = `head -c 3000 "${UPLOAD_DIR}/data.json"; wc -l ${UPLOAD_DIR}/data.json`;

      expect(summarizeShellCommand(command)).toBe("head -c 3000 data.json; wc -l data.json");
    });

    it("keeps the quotes around a path inside a one-line script", () => {
      const command = `python3 -c "import json; print(len(json.load(open('${UPLOAD_DIR}/data.json'))))"`;

      expect(summarizeShellCommand(command)).toBe(
        `python3 -c "import json; print(len(json.load(open('data.json'))))"`,
      );
    });

    it("drops a directory argument that is the worktree itself", () => {
      expect(summarizeShellCommand(`ls -la ${WORKTREE}`, WORKTREE)).toBe("ls -la");
      expect(summarizeShellCommand("ls .")).toBe("ls");
      expect(summarizeShellCommand("find . -name '*.md'", WORKTREE)).toBeUndefined();
    });

    it("reads uploads under any PASEO_HOME", () => {
      const command = `cat /work/repo/.dev/paseo-home/uploads/${UPLOAD_ID}/data.json`;

      expect(summarizeShellCommand(command)).toBe("cat data.json");
    });

    it("keeps a quoted file name with spaces whole", () => {
      const command = `head -c 3000 "${UPLOAD_DIR}/price list.csv" | sort`;

      expect(summarizeShellCommand(command)).toBe('head -c 3000 "price list.csv" | sort');
    });

    it("reads Windows upload paths", () => {
      const command = `type "C:\\Users\\user\\.paseo\\uploads\\${UPLOAD_ID}\\shot.png"`;

      expect(summarizeShellCommand(command)).toBe("type shot.png");
    });

    it("reads a quoted Windows upload path with a space in the user name", () => {
      const command = `type "C:\\Users\\John Doe\\.paseo\\uploads\\${UPLOAD_ID}\\data.json"`;

      expect(summarizeShellCommand(command)).toBe("type data.json");
    });

    it("reads a quoted Windows temp path with a space in the user name", () => {
      const command = `type "C:\\Users\\John Doe\\AppData\\Local\\Temp\\opencode\\arena\\ses_abc123\\out.txt"`;

      expect(summarizeShellCommand(command)).toBe("type out.txt");
    });

    it("reads a quoted upload path with a space in any folder", () => {
      const command = `cat "/Users/user/My Projects/repo/.dev/paseo-home/uploads/${UPLOAD_ID}/data.json"`;

      expect(summarizeShellCommand(command)).toBe("cat data.json");
    });

    it("keeps the other words of a quoted command line that names an upload", () => {
      expect(summarizeShellCommand(`bash -c "rm -rf ~/projects ${UPLOAD_DIR}/data.json"`)).toBe(
        'bash -c "rm -rf ~/projects data.json"',
      );
      expect(summarizeShellCommand(`sh -c "/bin/cat notes ${UPLOAD_DIR}/data.json"`)).toBe(
        'sh -c "/bin/cat notes data.json"',
      );
      expect(summarizeShellCommand(`bash -c "rm -rf ~/projects /tmp/opencode/notes.md"`)).toBe(
        'bash -c "rm -rf ~/projects notes.md"',
      );
    });

    it("leaves an upload path too long to match whole", () => {
      const home = `/home/user/${"checkout/.agent-duel/worktrees/turn/".repeat(30)}.dev/paseo-home`;
      const command = `cat ${home}/uploads/${UPLOAD_ID}/data.json`;

      expect(summarizeShellCommand(command)).toBeUndefined();
    });

    it("names the upload folder when a command lists it", () => {
      const command = `ls -la ${UPLOAD_DIR}/ && file ${UPLOAD_DIR}/data.json`;

      expect(summarizeShellCommand(command)).toBe("ls -la uploads/ && file data.json");
    });

    it("drops a cd into the upload folder", () => {
      const command = `cd ${UPLOAD_DIR} && jq 'length' data.json`;

      expect(summarizeShellCommand(command)).toBe("jq 'length' data.json");
    });

    it("shortens a contestant temp path and drops a cd into the temp folder", () => {
      const tempDir = "/var/folders/xx/yy/T/opencode/arena/ses_abc123";
      expect(summarizeShellCommand(`head -50 ${tempDir}/sh_01.out`)).toBe("head -50 sh_01.out");
      expect(summarizeShellCommand(`cd ${tempDir} && wc -l sh_01.out`)).toBe("wc -l sh_01.out");
    });

    it("shortens a path in the temp folder the contestants share", () => {
      const shared = "/private/var/folders/xx/yy/T/opencode";
      const command = `pandoc notes.docx -o ${shared}/notes.md; wc -l ${shared}/notes.md`;

      expect(summarizeShellCommand(command)).toBe("pandoc notes.docx -o notes.md; wc -l notes.md");
      expect(summarizeShellCommand("ls /tmp/opencode-cache/logs")).toBeUndefined();
    });

    it("keeps a worktree inside the temp folder relative to the worktree", () => {
      const worktree = "/tmp/opencode/repo/.agent-duel/worktrees/turn/generation-1-a";

      expect(summarizeShellCommand(`ls ${worktree}/src/arena`, worktree)).toBe("ls src/arena");
    });

    it("reads a quoted $TMPDIR as the contestant temp folder", () => {
      expect(summarizeShellCommand('cd "$TMPDIR/aitracking" && node overview.mjs')).toBe(
        "node overview.mjs",
      );
      expect(summarizeShellCommand('node "$TMPDIR/smoke.js"')).toBe("node smoke.js");
    });

    it("leaves a $TMPDIR mention inside a quoted string alone", () => {
      expect(summarizeShellCommand('echo "TMPDIR=$TMPDIR" && ls notes.md')).toBeUndefined();
    });

    it("shows paths inside the contestant worktree relative to it", () => {
      const command = `ls ${WORKTREE}/src/prompts/ && wc -l ${WORKTREE}/src/prompts/*.md`;

      expect(summarizeShellCommand(command, WORKTREE)).toBe(
        "ls src/prompts/ && wc -l src/prompts/*.md",
      );
      expect(summarizeShellCommand(`ls ${WORKTREE}`, WORKTREE)).toBe("ls");
    });

    it("drops a cd into the worktree and keeps one into a folder below it", () => {
      expect(summarizeShellCommand(`cd ${WORKTREE} && npm test`, WORKTREE)).toBe("npm test");
      expect(summarizeShellCommand(`cd ${WORKTREE}/api && npm test`, WORKTREE)).toBe(
        "cd api && npm test",
      );
    });

    it("leaves a sibling worktree whose name starts the same way", () => {
      const command = `ls ${WORKTREE}b/src`;

      expect(summarizeShellCommand(command, WORKTREE)).toBeUndefined();
    });

    it("shows other paths under the worktree's home directory as ~", () => {
      const home = "/home/user";
      const worktree = `${home}/repo/.agent-duel/worktrees/turn/generation-1-a`;

      expect(summarizeShellCommand(`ls -la ${home}/repo | head -50`, worktree)).toBe(
        "ls -la ~/repo | head -50",
      );
    });

    // A base64 blob beside a path once made the prefix patterns quadratic. The output is pinned
    // here; the cost is bounded by the cap and includes checks in upload-path.ts.
    it("summarizes a command with a long token beside a path", () => {
      const blob = "a/".repeat(16_000);
      const clipped = `echo ${"a/".repeat(97)}…`;

      expect(summarizeShellCommand(`echo ${blob} > ${UPLOAD_DIR}/blob.b64`)).toBe(clipped);
      expect(summarizeShellCommand(`echo ${blob} > $TMPDIR/blob.b64`)).toBe(clipped);
    });
  });

  describe("shell noise", () => {
    it("drops a cd with a silenced error and redirects to /dev/null", () => {
      const command = `cd ${WORKTREE} 2>/dev/null && ls -la && git log -5 2>/dev/null | head`;

      expect(summarizeShellCommand(command, WORKTREE)).toBe("ls -la && git log -5 | head");
    });

    it("keeps a redirect that merges stderr into stdout", () => {
      expect(summarizeShellCommand("npm test 2>&1 | tee test.log", WORKTREE)).toBeUndefined();
      const command = `cd ${WORKTREE} && npm test 2>&1 | tee test.log`;
      expect(summarizeShellCommand(command, WORKTREE)).toBe("npm test 2>&1 | tee test.log");
    });

    it("keeps a /dev/null redirect that the merge depends on", () => {
      expect(
        summarizeShellCommand("command -v jq >/dev/null 2>&1 && jq . data.json 2>/dev/null"),
      ).toBe("command -v jq >/dev/null 2>&1 && jq . data.json");
      expect(summarizeShellCommand("npm test 2>&1 >/dev/null")).toBeUndefined();
    });

    it("keeps a merge that a nearby redirect does not silence", () => {
      expect(summarizeShellCommand("npm test >/dev/null && git log 2>&1 | head")).toBe(
        "npm test && git log 2>&1 | head",
      );
    });

    it("drops a cd into the worktree along with its own redirects", () => {
      const command = `cd ${WORKTREE} >/dev/null 2>&1 && npm test`;

      expect(summarizeShellCommand(command, WORKTREE)).toBe("npm test");
    });

    it("drops echo lines that only print a rule or a framed heading", () => {
      const command = `echo "=== SRC ===" && wc -l src/*.js && echo "---"; echo '--- tests ---' && wc -l test/*.js && echo`;

      expect(summarizeShellCommand(command)).toBe("wc -l src/*.js && wc -l test/*.js");
    });

    it("keeps an echo that prints real output", () => {
      expect(summarizeShellCommand('echo "done" && ls', WORKTREE)).toBeUndefined();
      expect(summarizeShellCommand('echo "=== x ===" > notes.md && ls')).toBeUndefined();
    });

    it("does not name a script by the echo heading that opens its command", () => {
      const command = `cd ${WORKTREE}/docs && echo "=== guide.md: chars vs bytes ===" && node -e "
const fs = require('fs');
const s = fs.readFileSync('guide.md', 'utf8');
console.log('chars:', s.length);
" && cat notes.md`;

      expect(summarizeShellCommand(command, WORKTREE)).toBe(
        "guide.md · console.log('chars:', s.length);",
      );
    });
  });

  describe("shell commands over several lines", () => {
    it("drops a variable that names the upload and leads with the file", () => {
      const command = `F="${UPLOAD_DIR}/data.json"
jq 'length' "$F"
jq '[.[] | keys] | add | unique' "$F"
jq -r '.[0].id' $F | head -5`;

      expect(summarizeShellCommand(command)).toBe(
        "data.json · jq 'length' · jq '[.[] | keys] | add | unique'",
      );
    });

    it("passes over a comment that opens the commands", () => {
      const command = `F="${UPLOAD_DIR}/data.json"
# totals per vendor
jq -r '.[] | .vendor' "$F" | sort | uniq -c
echo "--- grand total ---"
jq 'length' "$F"`;

      expect(summarizeShellCommand(command)).toBe(
        "data.json · jq -r '.[] | .vendor' | sort | uniq -c · jq 'length'",
      );
    });

    it("joins a command continued onto the next line", () => {
      const command = `jq -r '.[] | .vendor' data.json \\
  | sort | uniq -c
wc -l data.json`;

      expect(summarizeShellCommand(command)).toBe(
        "jq -r '.[] | .vendor' data.json | sort | uniq -c · wc -l data.json",
      );
    });

    it("leaves a quoted string that spans lines alone", () => {
      const command = `git commit -m "Fix totals

Counts refunds once."`;

      expect(summarizeShellCommand(command)).toBeUndefined();
    });

    it("keeps a variable that names a project file", () => {
      expect(summarizeShellCommand(`F=data.json\njq 'length' "$F"`)).toBe(
        `F=data.json · jq 'length' "$F"`,
      );
    });
  });

  describe("scripts", () => {
    it("leads with the uploaded file and shows a heredoc's first lines", () => {
      const command = `python3 - <<'PY'
import json,collections
p='${UPLOAD_DIR}/data.json'
d=json.load(open(p))
print('COUNT',len(d))
print('KEYS',collections.Counter(k for r in d for k in r))
print('DONE')
PY`;

      expect(summarizeShellCommand(command)).toBe(
        "data.json · print('COUNT',len(d)) · print('KEYS',collections.Counter(k for r in d for k in r))",
      );
    });

    it("does not let an opening comment stand for what a script does", () => {
      const command = `bash <<'SH'
# Check the data
rm -rf ~/projects
SH`;

      expect(summarizeShellCommand(command)).toBe("rm -rf ~/projects");
    });

    it("reads a multi-line script passed with -c after a cd into the upload folder", () => {
      const command = `cd ${UPLOAD_DIR} && python3 -c "
import json
with open('data.json') as f:
    rows = json.load(f)
for r in rows:
    print('='*80)
    print(r['id'], r['name'])
"`;

      expect(summarizeShellCommand(command)).toBe(
        "data.json · for r in rows: · print(r['id'], r['name'])",
      );
    });

    it("reads a multi-line script passed with -e", () => {
      const command = `node -e '
const fs = require("fs");
const path = "${UPLOAD_DIR}/data.json";
const rows = JSON.parse(fs.readFileSync(path, "utf8"));
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  console.log("row", i, row.name);
}
'`;

      expect(summarizeShellCommand(command)).toBe(
        "data.json · for (let i = 0; i < rows.length; i++) { · const row = rows[i];",
      );
    });

    it("tells apart scripts that share their setup", () => {
      const script = (line: string) => `python3 - <<'PY'
import json
rows=json.load(open('${UPLOAD_DIR}/data.json'))
for r in rows:
    ${line}
PY`;

      expect(summarizeShellCommand(script("print(r['price'])"))).toBe(
        "data.json · for r in rows: · print(r['price'])",
      );
      expect(summarizeShellCommand(script("print(r['stock'])"))).toBe(
        "data.json · for r in rows: · print(r['stock'])",
      );
    });

    it("names the copy a script in the temp folder reads", () => {
      const command = `cd "$TMPDIR/aitracking" && node -e '
const docs = JSON.parse(fs.readFileSync("aitracking.json", "utf8"));
console.log("docs", docs.length);
console.log("keys", Object.keys(docs[0]).length);
'`;

      expect(summarizeShellCommand(command)).toBe(
        'aitracking.json · console.log("docs", docs.length); · console.log("keys", Object.keys(docs[0]).length);',
      );
    });

    it("passes over the comment that opens a script", () => {
      const command = `python3 - <<'PY'
import json
rows=json.load(open('${UPLOAD_DIR}/data.json'))
# Price changes per vendor.
for r in rows:
    # skip drafts
    print(r['vendor'], r['price'])
PY`;

      expect(summarizeShellCommand(command)).toBe(
        "data.json · for r in rows: · print(r['vendor'], r['price'])",
      );
    });

    it("passes over comments and helper definitions", () => {
      const command = `node << 'EOF'
// eslint-disable no-console
// setup
const rows = require("${UPLOAD_DIR}/data.json");
// Format one row.
function show(row) {
  return row.name;
}
console.log("total", rows.length);
EOF`;

      expect(summarizeShellCommand(command)).toBe('data.json · console.log("total", rows.length);');
    });

    it("skips what a helper function prints", () => {
      const command = `node << 'EOF'
const rows = require("${UPLOAD_DIR}/data.json");
function show(row) {
  console.log("helper", row);
}
console.log("total", rows.length);
EOF`;

      expect(summarizeShellCommand(command)).toBe('data.json · console.log("total", rows.length);');
    });

    it("shows the first lines past the setup when a script prints nothing", () => {
      const command = `python3 - <<'PY'
import json
rows=json.load(open('${UPLOAD_DIR}/data.json'))
rows.sort(key=lambda r: r['id'])
json.dump(rows, open('sorted.json','w'))
PY`;

      expect(summarizeShellCommand(command)).toBe(
        "data.json · rows.sort(key=lambda r: r['id']) · json.dump(rows, open('sorted.json','w'))",
      );
    });

    it("summarizes a script that reads no upload", () => {
      const command = `cd ${WORKTREE}/api && node -e "
import('./src/version.js').then(m => console.log(m.version()));
"`;

      expect(summarizeShellCommand(command, WORKTREE)).toBe(
        "import('./src/version.js').then(m => console.log(m.version()));",
      );
    });

    it("leads a file-writing heredoc with its target and first lines", () => {
      const command = `mkdir -p scratch && cat > scratch/shape.mjs <<'EOF'
import { readFileSync } from "node:fs";
const rows = JSON.parse(readFileSync("${UPLOAD_DIR}/data.json", "utf8"));
console.log("count:", rows.length);
console.log("vendors:", new Set(rows.map((row) => row.vendor)).size);
EOF`;

      expect(summarizeShellCommand(command)).toBe(
        'scratch/shape.mjs · console.log("count:", rows.length); · console.log("vendors:", new Set(rows.map((row) => row.vendor)).size);',
      );
    });

    it("drops echo and mkdir setup ahead of a file-writing heredoc", () => {
      const command = `echo . && mkdir -p scratch && cat > scratch/detail.mjs <<'EOF'
// Detail for each order
import { readFileSync } from "node:fs";
console.log(readFileSync("orders.json", "utf8"));
EOF`;

      expect(summarizeShellCommand(command)).toBe(
        'scratch/detail.mjs · console.log(readFileSync("orders.json", "utf8"));',
      );
    });

    it("drops an echoed temp directory ahead of a file-writing heredoc", () => {
      const command = `echo $TMPDIR && mkdir -p "$TMPDIR/scratch" && cat > "$TMPDIR/scratch/detail.mjs" <<'EOF'
// Detail for each order
console.log("orders:", 3);
console.log("vendors:", 2);
EOF`;

      expect(summarizeShellCommand(command)).toBe(
        'scratch/detail.mjs · console.log("orders:", 3); · console.log("vendors:", 2);',
      );
    });

    it("shows a written script's target relative to the worktree", () => {
      const command = `cat > ${WORKTREE}/scratch/scans.mjs <<'EOF'
const scans = [];
console.log("total:", scans.length);
console.log("failed:", scans.filter((scan) => scan.failed).length);
EOF`;

      expect(summarizeShellCommand(command, WORKTREE)).toBe(
        'scratch/scans.mjs · const scans = []; · console.log("total:", scans.length);',
      );
    });

    it("resolves a variable the command exports before the heredoc", () => {
      const scratch = "/private/var/folders/xx/yy/T/opencode/arena/ses_abc123";
      const command = `export W=${scratch} && mkdir -p $W/an && cat > $W/an/usage.py <<'EOF'
// Token usage per document
console.log("done");
EOF`;

      expect(summarizeShellCommand(command)).toBe('an/usage.py · console.log("done");');
    });

    it("reads a variable holding $TMPDIR as the scratch folder", () => {
      const command = `export W=$TMPDIR && cat > "$W/usage.py" <<'EOF'
// Token usage per document
console.log("done");
EOF`;

      expect(summarizeShellCommand(command)).toBe('usage.py · console.log("done");');
    });

    it("does not discard work between an assignment and a file-writing heredoc", () => {
      const command = `x=1 && jq 'length' data.json && cat > shape.mjs <<'EOF'
console.log("done");
EOF`;

      expect(summarizeShellCommand(command)).toBeUndefined();
    });

    it("does not discard work before a file-writing heredoc", () => {
      const command = `jq 'length' data.json && cat > shape.mjs <<'EOF'
console.log("done");
EOF`;

      expect(summarizeShellCommand(command)).toBeUndefined();
    });

    it("keeps a heredoc that writes a document as the command it is", () => {
      const command = `cat > notes.md <<'EOF'
# Notes
EOF`;

      expect(summarizeShellCommand(command)).toBeUndefined();
    });
  });

  it("names every uploaded file a script reads", () => {
    const command = `python3 - <<'PY'
a=open('${UPLOAD_DIR}/a.json').read()
b=open('${UPLOAD_DIR}/b.json').read()
print(a == b)
PY`;

    expect(summarizeShellCommand(command)).toBe("a.json, b.json · print(a == b)");
  });

  it("cuts a long summary short", () => {
    const command = `cat ${UPLOAD_DIR}/data.json | grep ${"x".repeat(300)}`;
    const summary = summarizeShellCommand(command);

    expect(summary).toHaveLength(200);
    expect(summary?.endsWith("…")).toBe(true);
  });
});
