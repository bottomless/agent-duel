import path from "node:path";
import { describe, expect, test } from "vitest";
import { asarUnpackedPath, prependEnvPath } from "./sherpa-runtime-env.js";

describe("asarUnpackedPath", () => {
  test("names the unpacked copy of a directory inside the app archive", () => {
    expect(
      asarUnpackedPath(
        "C:\\Users\\Kullanıcı\\AppData\\Local\\Programs\\Agent Duel\\resources\\app.asar\\node_modules\\sherpa-onnx-win-x64",
      ),
    ).toBe(
      "C:\\Users\\Kullanıcı\\AppData\\Local\\Programs\\Agent Duel\\resources\\app.asar.unpacked\\node_modules\\sherpa-onnx-win-x64",
    );
    expect(
      asarUnpackedPath(
        "/Applications/Agent Duel.app/Contents/Resources/app.asar/node_modules/sherpa-onnx-darwin-arm64",
      ),
    ).toBe(
      "/Applications/Agent Duel.app/Contents/Resources/app.asar.unpacked/node_modules/sherpa-onnx-darwin-arm64",
    );
  });

  test("leaves a directory outside an archive, or already unpacked, as it is", () => {
    const dev = "C:\\repo\\node_modules\\sherpa-onnx-win-x64";
    const unpacked = "C:\\app\\resources\\app.asar.unpacked\\node_modules\\sherpa-onnx-win-x64";
    expect(asarUnpackedPath(dev)).toBe(dev);
    expect(asarUnpackedPath(unpacked)).toBe(unpacked);
  });

  test("puts the unpacked directory, not the archive, first in the loader path", () => {
    const libDir = asarUnpackedPath("/app/resources/app.asar/node_modules/sherpa-onnx-win-x64");
    const next = prependEnvPath(["/usr/bin", "/bin"].join(path.delimiter), libDir);
    expect(next.split(path.delimiter)[0]).toBe(
      "/app/resources/app.asar.unpacked/node_modules/sherpa-onnx-win-x64",
    );
  });
});
