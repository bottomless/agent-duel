import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const helperSource = path.join(scriptDir, "vote-input-native-post.c");

if (process.platform !== "darwin") {
  console.log("SKIP: native vote-input regression requires macOS AppKit and CoreGraphics.");
  process.exit(0);
}

const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "vote-input-native-electron-"));
const helper = path.join(fixtureDir, "vote-input-native-post");
const fixture = path.join(fixtureDir, "main.cjs");
const handler = path.join(desktopDir, "dist/features/vote-input.js");
const preload = path.join(desktopDir, "dist/preload.js");

try {
  await access(handler);
  await access(preload);
  execFileSync(
    "xcrun",
    ["clang", helperSource, "-framework", "ApplicationServices", "-o", helper],
    { stdio: "inherit" },
  );

  const accessResult = JSON.parse(execFileSync(helper, ["check-access"], { encoding: "utf8" }));
  if (!accessResult.postAccess) {
    console.log(
      "SKIP: macOS CGEvent post accessibility permission is unavailable; native vote-input regression was not run.",
    );
    process.exit(0);
  }

  const html = `<style>body { padding: 40px } button, #keyboard { padding: 24px; margin: 8px }</style>
<button id="vote">Pointer vote</button><div role="button" tabindex="0" id="keyboard">Keyboard vote</div>
<script>
window.results = [];
const target = { kind: 'battle', agentId: 'test-agent', targetId: 'test-turn', vote: 'a' };
window.delay = 0;
async function record(event) {
  const input = event.type === 'keyup'
    ? { kind: 'keyboard', key: event.key }
    : { kind: 'pointer', screenX: event.screenX, screenY: event.screenY };
  if (window.delay) await new Promise(resolve => setTimeout(resolve, window.delay));
  const evidence = await window.paseoDesktop.voteInput.source({ target, input });
  const source = evidence.source;
  const replayEvidence = await window.paseoDesktop.voteInput.source({ target, input });
  const replay = replayEvidence.source;
  window.results.push({ kind: input.kind, source, replay, trusted: event.isTrusted });
}
document.getElementById('vote').onclick = record;
document.getElementById('keyboard').onkeyup = record;
</script>`;
  await writeFile(
    fixture,
    `const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  app.setActivationPolicy?.('accessory');
  app.dock?.hide();
  require(${JSON.stringify(handler)}).registerVoteInputHandlers();
  const window = new BrowserWindow({ width: 600, height: 400, x: 100, y: 100, show: true,
    webPreferences: { preload: ${JSON.stringify(preload)}, sandbox: true, contextIsolation: true } });
  await window.loadURL('data:text/html,' + encodeURIComponent(${JSON.stringify(html)}));
  window.show();
  window.focus();
  app.focus({ steal: true });
});
app.on('window-all-closed', () => app.quit());`,
  );

  let electron;
  try {
    electron = await _electron.launch({ executablePath: require("electron"), args: [fixture] });
    const page = await electron.firstWindow();
    await page.waitForSelector("#vote");

    const readResult = async (index) => {
      await page.waitForFunction((expected) => window.results.length > expected, index);
      return await page.evaluate((expected) => window.results[expected], index);
    };
    const post = (x, y, mode, kind) =>
      JSON.parse(
        execFileSync(helper, [String(electron.process().pid), String(x), String(y), mode, kind], {
          encoding: "utf8",
        }),
      );
    const resultCount = () => page.evaluate(() => window.results.length);

    const cdpIndex = await resultCount();
    await page.getByRole("button", { name: "Pointer vote", exact: true }).click();
    assert.deepEqual(await readResult(cdpIndex), {
      kind: "pointer",
      source: "unverified",
      replay: "unverified",
      trusted: true,
    });

    const box = await page.locator("#vote").boundingBox();
    const content = await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentBounds(),
    );
    assert(box && content, "Could not resolve the fixture button's screen position");
    const screenX = content.x + box.x + box.width / 2;
    const screenY = content.y + box.y + box.height / 2;

    const pointerIndex = await resultCount();
    const pointerPost = post(screenX, screenY, "default", "pointer");
    assert.equal(pointerPost.postAccess, true);
    assert.deepEqual(await readResult(pointerIndex), {
      kind: "pointer",
      source: "injected",
      replay: "unverified",
      trusted: true,
    });

    await page.locator("#keyboard").focus();
    const keyboardIndex = await resultCount();
    const keyboardPost = post(screenX, screenY, "default", "keyboard");
    assert.equal(keyboardPost.postAccess, true);
    assert.deepEqual(await readResult(keyboardIndex), {
      kind: "keyboard",
      source: "injected",
      replay: "unverified",
      trusted: true,
    });

    await page.locator("#keyboard").focus();
    const spoofedKeyboardIndex = await resultCount();
    const spoofedKeyboardPost = post(screenX, screenY, "zero", "keyboard");
    assert.equal(spoofedKeyboardPost.postAccess, true);
    assert.deepEqual(await readResult(spoofedKeyboardIndex), {
      kind: "keyboard",
      source: "injected",
      replay: "unverified",
      trusted: true,
    });

    await page.evaluate(() => {
      window.delay = 2200;
    });
    const expiredIndex = await resultCount();
    const expiredPost = post(screenX, screenY, "default", "pointer");
    assert.equal(expiredPost.postAccess, true);
    assert.deepEqual(await readResult(expiredIndex), {
      kind: "pointer",
      source: "unverified",
      replay: "unverified",
      trusted: true,
    });

    console.log(
      "PASS: CDP input is unverified; native pointer and keyboard activations are injected once; repeated lookup and expired evidence are unverified.",
    );
  } finally {
    await electron?.close();
  }
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}
