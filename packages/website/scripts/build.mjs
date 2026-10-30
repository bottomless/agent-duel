import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const website = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(website, "../..");
const output = path.join(website, "dist");

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm", ["run", "build:app-deps"], root);
run(
  "npx",
  ["expo", "export", "--platform", "web", "--max-workers", "2"],
  path.join(root, "packages/app"),
  {
    ...process.env,
    PASEO_WEBSITE_BUILD: "1",
    PASEO_WEB_PLATFORM: "web",
  },
);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(website, "public"), output, { recursive: true });
await cp(path.join(root, "packages/app/dist"), path.join(output, "remote"), { recursive: true });

// Expo prefixes bundled assets, but files copied from public keep their literal URLs.
const htmlPath = path.join(output, "remote/index.html");
const html = await readFile(htmlPath, "utf8");
await writeFile(htmlPath, html.replace('href="/manifest.json"', 'href="/remote/manifest.json"'));
const manifestPath = path.join(output, "remote/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.id = "/remote/";
manifest.start_url = "/remote/";
manifest.scope = "/remote/";
manifest.icons = manifest.icons.map((icon) => ({ ...icon, src: `/remote${icon.src}` }));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
