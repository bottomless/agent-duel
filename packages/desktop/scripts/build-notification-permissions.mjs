import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const output = resolve(root, "dist/native/notification-permissions.node");
  mkdirSync(dirname(output), { recursive: true });
  execFileSync(
    "xcrun",
    [
      "clang++",
      "-std=c++17",
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-fobjc-arc",
      "-fblocks",
      "-DNAPI_VERSION=8",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-mmacosx-version-min=12.0",
      "-I",
      require("node-api-headers").include_dir,
      "-framework",
      "Foundation",
      "-framework",
      "UserNotifications",
      resolve(root, "native/notification-permissions.mm"),
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
}
