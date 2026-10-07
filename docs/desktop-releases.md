# Manual macOS releases

Merging to main runs CI; it does not publish an installer. The Desktop Release
workflow only runs manually on main. It builds the exact commit captured when
Run workflow is clicked and creates a draft GitHub release after verification.
The first workflow supports Apple Silicon (arm64) only.

## One-time setup

Create a GitHub environment named `desktop-release`. Restrict it to main and
configure a required reviewer where your GitHub plan supports this. Store these
secrets in that environment:

- `MAC_CSC_LINK`: base64-encoded, password-protected PKCS#12 (.p12) containing the
  Developer ID Application certificate and its matching private key.
- `MAC_CSC_KEY_PASSWORD`: the .p12 password.
- `APPLE_ID`: the Apple account used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: that account's app-specific password.
- `APPLE_TEAM_ID`: `LGVJP2HNM2`.

The certificate must be Developer ID Application: Bottomless Supply Inc
(LGVJP2HNM2). Keep the private key and a secure backup outside the repository.
Creating an Apple app-specific password and uploading credentials to GitHub are
separate setup steps; this workflow does not provision them.

## Start a release

1. Commit the desired version to the repository using its version tooling and
   merge it to main. Ensure CI passes on that commit.
2. Open GitHub → Actions → Desktop Release → Run workflow.
3. Select main and enter the committed version without a leading `v`, for example
   `0.4.0-beta.3`. Root and desktop package versions must match the input.
4. Approve the environment deployment if required. The workflow builds, signs,
   notarizes, and verifies the app and DMG before creating a draft release.
5. Download the DMG from the run's `signed-macos-arm64` artifact and test it on a
   Mac as a fresh download. Check launch, sign-in, and a normal battle.
6. Open Releases, review the draft's assets and notes, and click Publish release
   only after testing. Versions containing a hyphen are marked as prereleases.

The workflow never publishes a release automatically and refuses an existing
release version. It does not deploy the hosted backend, publish npm packages,
create Windows/Linux/Intel installers, or enable in-app automatic updates.
A failed build creates no draft release; retained artifacts may help diagnose
failures after installer verification. Retry before a draft exists, or use a new
version after a draft has been created.
