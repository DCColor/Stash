# Stash

Tauri app (Rust + webview). macOS arm64 only. Product slug: `stash`.
**Free tool — no licensing.** The only Graviton desktop product without it.

## Build, signing, and release

Procedure is NOT documented in this repo. It lives in the Graviton-Releases repo, checked
out as a sibling at `../../Graviton-Releases` (github.com/DCColor/Graviton-Releases,
private). Read it before answering anything about build, signing, release, or distribution:

- `docs/stacks/tauri.md` — this app's build and signing procedure, the staple-before-you-
  package rule, the CSP trap, and the three-version-files problem
- `docs/DISTRIBUTION.md` — R2 layout, manifest.json schema, Worker routing, public URLs,
  `upload-release.sh`
- `docs/IDENTITY.md` — Apple certificates and accounts. Mac-only, so no Azure.
- `docs/MACHINE-STATE.md` — build Mac state, keychain, what is not backed up

Those documents are canonical. If anything here contradicts them, they are correct.

Note the signing identity string here includes the `Developer ID Application: ` prefix,
because Tauri's bundler shells out to `codesign`. The Electron products must omit it. Same
certificate, two required spellings — see `IDENTITY.md`. Do not "fix" one to match the
other.

**Do not infer procedure from `stacks/electron.md`.** Different toolchain, different
signing mechanics.

## What is specific to Stash

- `BUILD.md` — at the **repo root**, not `docs/`. This repo has no `docs/` directory.
- `scripts/build-and-release.sh` — the whole pipeline, one entry point
- `src-tauri/tauri.conf.json` — version, bundle identifier, signing identity, hardened
  runtime, entitlements path, **and the CSP**
- `src-tauri/entitlements.plist` — six keys, a subset of the Electron set

## Rules

**The `.app` must be notarized and stapled BEFORE the DMG is created from it.** Stash
shipped 0.5.7 with an unstapled `.app` inside a validating DMG because the copy happened
first. Verify by mounting the produced DMG and running `xcrun stapler validate` on the
`.app` inside — not just on the DMG. A DMG that validates proves nothing about its
contents.

**The CSP `connect-src` must include `https://releases.graviton.tools`.** The bare
`graviton.tools` does not cover the subdomain — different origin. Stash shipped with that
for months and every update check was silently blocked by the webview.

**Never use an empty `catch {}` on the update path.** Log the failure. Silence is what hid
the CSP bug.

**The version lives in three files** — `package.json`, `src-tauri/tauri.conf.json`, and
`src-tauri/Cargo.toml` — and nothing checks they agree. The release script reads
`package.json`; the in-app update check compares against `Info.plist`, which Tauri
populates from `tauri.conf.json`. A mismatch between those two gives every user a
permanent phantom "update available".

**Publish via the shared uploader** — `../../Graviton-Releases/upload-release.sh stash`.
Never hand-write `manifest.json`. Stash did until 0.5.8 and the schema drifted: it emitted
a `mac` key instead of `mac-arm64` and omitted `notes` entirely.

**arm64 only.** No Intel target. The artifact is `Stash-<version>-arm64.dmg` and must
match the `stash)` case block in `upload-release.sh` exactly.

**Tauri's built-in updater is deliberately not used.** No `tauri-plugin-updater`, no
keypair, no `latest.json`. Stash implements the Graviton notifier contract instead — fetch
the manifest, compare, open the browser, never auto-install. Do not introduce Tauri's
updater; its private key would become an unrecorded single point of failure for every
existing install.

**Tauri's DMG bundler is bypassed** — it fails on macOS 26 with "Not enough arguments".
The script builds `--bundles app` and creates the image with `hdiutil`. `"targets": "all"`
in the config is dead.

**Commit and push Graviton-Releases before releasing** — `upload-release.sh` is invoked
from the sibling working tree.

## Known fragilities

Recorded in `stacks/tauri.md` § Fragilities; none block a release, none are fixed:

- The release script commits and pushes *before* building
- `git add .` stages everything unconditionally
- `git commit … || echo` swallows every commit failure and defeats `set -e`
- `notarytool submit --wait` has no timeout or retry
- No manifest verification after upload
- The DMG itself is unsigned — Manifold signs it before notarizing; Stash does not. It
  validates, but it is the last divergence from the Swift stack's sequence.