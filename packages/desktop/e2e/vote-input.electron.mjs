import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "vote-input-electron-"));
const fixture = path.join(fixtureDir, "main.cjs");
const handler = path.join(desktopDir, "dist/features/vote-input.js");
const preload = path.join(desktopDir, "dist/preload.js");
const html = `<button id="vote">Vote</button><div role="button" tabindex="0" id="keyboard">Keyboard vote</div>
<script>
window.results = [];
async function record(event, input) {
  const os = await window.paseoDesktop.voteInput.observe(input);
  const replay = await window.paseoDesktop.voteInput.observe(input);
  window.results.push({ os, replay, trusted: event.isTrusted });
}
document.getElementById('vote').onclick = event => record(event, { kind: 'pointer', screenX: event.screenX, screenY: event.screenY });
document.getElementById('keyboard').onkeyup = event => record(event, { kind: 'keyboard', key: event.key });
</script>`;
await writeFile(
  fixture,
  `const { app, BrowserWindow } = require('electron');
  app.whenReady().then(async () => {
    app.setActivationPolicy?.('accessory');
    app.dock?.hide();
    require(${JSON.stringify(handler)}).registerVoteInputHandlers();
    const window = new BrowserWindow({ width: 500, height: 350, x: 8, y: 32, show: false, webPreferences: { preload: ${JSON.stringify(preload)}, sandbox: true, contextIsolation: true } });
    await window.loadURL('data:text/html,' + encodeURIComponent(${JSON.stringify(html)}));
    window.showInactive();
  });
  app.on('window-all-closed', () => app.quit());`,
);

let electron;
try {
  electron = await _electron.launch({ executablePath: require("electron"), args: [fixture] });
  const page = await electron.firstWindow();
  const expected =
    process.platform === "darwin" || process.platform === "win32"
      ? { status: "unmatched" }
      : { status: "unavailable" };
  await page.getByRole("button", { name: "Vote", exact: true }).click();
  await page.waitForFunction(() => window.results.length === 1);
  assert.deepEqual(await page.evaluate(() => window.results[0]), {
    os: expected,
    replay: expected,
    trusted: true,
  });
  await page.getByRole("button", { name: "Keyboard vote", exact: true }).press("Enter");
  await page.waitForFunction(() => window.results.length === 2);
  assert.deepEqual(await page.evaluate(() => window.results[1]), {
    os: expected,
    replay: expected,
    trusted: true,
  });
  const spoofed = await page.evaluate(() =>
    window.paseoDesktop.voteInput.observe({
      kind: "pointer",
      screenX: 0,
      screenY: 0,
      status: "matched",
      event: { platform: "darwin", sourceProcess: "none" },
    }),
  );
  assert.deepEqual(spoofed, expected);
  const invalidRejected = await page.evaluate(async () => {
    try {
      await window.paseoDesktop.voteInput.observe({ kind: "keyboard", key: "a" });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(invalidRejected, true);
  console.log(
    "PASS: CDP pointer and keyboard votes have no matching OS event; the renderer cannot supply an OS observation; malformed input is rejected.",
  );
} finally {
  await electron?.close();
  await rm(fixtureDir, { recursive: true, force: true });
}
