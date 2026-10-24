# Manual desktop releases

Merging to main runs CI; it does not publish an installer. The Desktop Release
workflow only runs manually on main. It builds the exact commit captured when
Run workflow is clicked and creates a draft GitHub release after verification.
It builds a signed Apple Silicon (arm64) app and an unsigned Windows x64
installer, and the draft is created only when both succeed.

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

1. Update every workspace version with the existing version command and merge
   its release commit to main. For the next beta, run
   `npm run version:all:beta:next`; use `npm run version:all:promote` for a stable
   release. Push the commit without the local tag: Desktop Release creates the
   remote release tag after verification. Ensure CI passes on that commit.
2. Open GitHub → Actions → Desktop Release → Run workflow.
3. Select main and enter the version produced by the command without a leading
   `v`. Root and desktop package versions must match the input.
4. Approve the environment deployment if required. The workflow builds, signs,
   notarizes, and verifies the app and DMG before creating a draft release.
5. Download the DMG from the run's `signed-macos-arm64` artifact and test it on a
   Mac as a fresh download, and the installer from `windows-x64` on Windows.
   Check launch, sign-in, and a normal battle.
6. Open Releases, review the draft's assets and notes, and click Publish release
   only after testing. Leave "Set as a pre-release" off, including for betas.

## In-app updates

Release builds check the published GitHub release when they start and every 30
minutes, download a newer version in the background and offer Install in the
sidebar; an update the user does not install is applied when the app quits. The
Mac reads `latest-mac.yml` and the ZIP from the release; Windows reads
`latest.yml`, the Setup exe and its blockmap.

- Publish is the rollout. A draft is invisible to the app, so test the draft's
  DMG first. A published release reaches every running copy within about half an
  hour, and there is no downgrade: fix a bad release with a newer version.
- The default channel only follows GitHub's latest release, which excludes
  prereleases. A release marked as a pre-release reaches nobody.
- Builds before 0.4.0-beta.10 have updates off, and so do Windows builds made
  outside this workflow. Their users install a newer build by hand once; later
  versions arrive by themselves.
- The update's code signature must match the installed app's, so only the
  signed Developer ID builds from this workflow can update each other. A local
  build can check and download an update, and macOS rejects the install.
- Windows builds are unsigned, so the updater skips the signature check (it
  runs only when `app-update.yml` names a publisher). Once Windows builds are
  signed, every later build must be signed with the same publisher name.
  `latest.yml` holds the exe's sha512: never rebuild or re-sign the exe after
  the workflow writes it.
- The Windows installer is one-click and per user, in
  `%LOCALAPPDATA%\Programs\Agent Duel`: no pages and no UAC, so an update installs
  silently. An assisted or per-machine installer would ask again on every update.

The workflow fetches the complete tag history and refuses a version that is not
newer than the highest canonical `vX.Y.Z` or `vX.Y.Z-beta.N` tag. Stable versions
sort after beta versions for the same base version, and beta numbers use numeric
ordering. It also refuses an existing GitHub release version. The workflow never
publishes a release automatically. It does not deploy the hosted backend, publish
npm packages, or create Linux, Intel Mac or Windows arm64 installers.
A failed build creates no draft release; retained artifacts may help diagnose
failures after installer verification. Retry before a draft exists, or use a new
version after a draft has been created.
