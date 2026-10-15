import assert from "node:assert/strict";
import test from "node:test";
import {
  compareReleaseVersions,
  computeNextReleaseVersion,
  getHighestCanonicalReleaseVersion,
  getReleaseInfoFromSourceTag,
  parseReleaseVersion,
} from "./release-version-utils.mjs";

test("computes the next beta patch from a stable version", () => {
  assert.equal(computeNextReleaseVersion("0.1.59", "beta-patch"), "0.1.60-beta.1");
});

test("advances beta versions", () => {
  assert.equal(computeNextReleaseVersion("0.1.60-beta.1", "beta-next"), "0.1.60-beta.2");
});

test("promotes beta versions to stable", () => {
  assert.equal(computeNextReleaseVersion("0.1.60-beta.2", "promote"), "0.1.60");
});

test("parses beta release metadata", () => {
  assert.deepEqual(parseReleaseVersion("0.1.60-beta.1"), {
    version: "0.1.60-beta.1",
    major: 0,
    minor: 1,
    patch: 60,
    prerelease: "beta.1",
    baseVersion: "0.1.60",
    isPrerelease: true,
    isBeta: true,
    betaNumber: 1,
  });
});

test("emits beta release info from tags", () => {
  assert.deepEqual(getReleaseInfoFromSourceTag("v0.1.60-beta.1"), {
    sourceTag: "v0.1.60-beta.1",
    releaseTag: "v0.1.60-beta.1",
    version: "0.1.60-beta.1",
    baseVersion: "0.1.60",
    prerelease: "beta.1",
    isPrerelease: true,
    isBeta: true,
    betaNumber: 1,
    releaseType: "prerelease",
    releaseChannel: "beta",
    isSmokeTag: false,
  });
});

test("rejects non-beta prerelease versions", () => {
  assert.throws(() => parseReleaseVersion("0.1.60-canary.1"), /Expected beta prerelease versions/);
});

test("orders beta numbers and stable releases according to semver precedence", () => {
  assert.equal(compareReleaseVersions("0.1.60-beta.10", "0.1.60-beta.2"), 1);
  assert.equal(compareReleaseVersions("0.1.60-beta.2", "0.1.60"), -1);
  assert.equal(compareReleaseVersions("0.1.60", "0.1.60-beta.10"), 1);
});

test("finds the highest canonical release tag", () => {
  assert.equal(
    getHighestCanonicalReleaseVersion([
      "v0.4.0-beta.2",
      "v0.4.0-beta.10",
      "desktop-v9.0.0",
      "v0.3.99",
      "v0.4.0",
      "v0.5.0-canary.1",
    ]),
    "0.4.0",
  );
});

test("returns no version when there are no canonical release tags", () => {
  assert.equal(getHighestCanonicalReleaseVersion(["desktop-v0.4.0", "v0.4.0-canary.1"]), null);
});
