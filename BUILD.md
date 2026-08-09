# Stash — Build & Release Guide

**Repo:** https://github.com/DCColor/Stash
**Slug:** `stash`

Stash satisfies the Graviton distribution contract. **The contract itself — R2 layout,
manifest schema, public URLs, update-check behaviour — is in
`Graviton-Releases/docs/DISTRIBUTION.md` and is not repeated here.** This file covers only
what is specific to Stash.

## Release

```bash
npm run release
```

`scripts/build-and-release.sh`, in order:

1. Commits and pushes to GitHub
2. Builds `Stash.app` — `--bundles app --target aarch64-apple-darwin`, signed by Tauri
3. Notarizes and staples **the `.app`**, then validates the ticket
4. Builds the DMG from the stapled bundle with `hdiutil`
5. Notarizes, staples and validates the DMG
6. Mounts the DMG and validates the `.app` inside it — signature, ticket, Gatekeeper
7. Hands off to `../../Graviton-Releases/upload-release.sh stash`, which does all
   publishing: upload, archive, release notes, manifest, prune
8. Fetches the published manifest back and requires it to name this version and DMG

Steps 3–6 are the order that matters. Stapling writes into the bundle, so it has to happen
before the DMG is built from it — doing it afterwards staples the original and ships an
unticketed copy. That was the bug in 0.5.7 and earlier: the DMG validated, the `.app`
inside it did not. Step 6 is the check that would have caught it, and the only one that
looks at what actually ships.

Nothing in this repo writes a manifest or constructs an R2 key. That is deliberate — the
hand-written manifest here emitted a `mac` asset key long after the contract moved to
`mac-arm64`, and only kept working because the Worker still tolerated the old key.

## Release notes

`RELEASE_NOTES.md`, section heading matching the version exactly. Add the section **before**
releasing — the uploader warns rather than fails, so a forgotten section ships
`"notes": []` and the update prompt shows a bare version number. One line per bullet; a
wrapped line is silently truncated at the wrap.

## Version

Bump in all three files before releasing:

- `package.json` — the uploader reads the version from here
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

```bash
sed -i '' 's/"version": "OLD"/"version": "NEW"/' package.json src-tauri/tauri.conf.json
sed -i '' 's/^version = "OLD"/version = "NEW"/' src-tauri/Cargo.toml
```

## Code signing

Shared Graviton identity. Full details, renewal calendar and credential locations are in
`Graviton-Releases/docs/IDENTITY.md`; the build Mac's state is in `MACHINE-STATE.md`.
(Both replace the retired `SIGNING.md`.)

| Item | Value |
|---|---|
| Certificate | `Developer ID Application: Amigo Media LLC (8UQ7MDM87B)` |
| Notarization profile | `graviton-notarytool` |
| Entitlements | `src-tauri/entitlements.plist` |
| Configured in | `src-tauri/tauri.conf.json` → `bundle.macOS.signingIdentity` |

**Tauri takes the identity string with the `Developer ID Application:` prefix**, because it
shells out to `codesign`. This is the Manifold spelling, not the electron-builder one — see
IDENTITY.md § "The identity string has two required spellings".

## Architecture

arm64 only (Apple Silicon). 0.5.7 was the last universal build; Intel support was dropped
after it, so the first arm64-only release is the next one published.

Requires `rustup target add aarch64-apple-darwin`.

## Verifying a signed build

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Stash.app
xcrun stapler validate /Applications/Stash.app
spctl --assess --type exec -vvv /Applications/Stash.app
```

Expected:

- codesign: "valid on disk", "satisfies its Designated Requirement"
- stapler: "The validate action worked!"
- spctl: "accepted, source=Notarized Developer ID"

Run these against a copy dragged out of the shipped DMG, not the build tree — an unstapled
`.app` in a stapled DMG passes every check until you test the copy a user actually gets.

## Known issues

### `bundle_dmg.sh` fails on macOS 26 beta

Tauri's built-in DMG bundler fails with "Not enough arguments". Worked around by building
`--bundles app` and creating the DMG with `hdiutil`; the release script handles it. This is
also why the DMG filename is set in the script rather than in `tauri.conf.json` — Tauri's
bundler never runs.

### DMG volume icon not showing

The DMG mounts without a custom icon. `SetFile` and `Rez`, needed to embed an icns, come
from Xcode's additional tools package. The app icon in Applications is unaffected.

## Prerequisites (one-time)

- Rust via `rustup`, plus `rustup target add aarch64-apple-darwin`
- Node.js 22+
- `wrangler` authenticated (`wrangler login`) — used by the shared uploader
- `Graviton-Releases` checked out alongside this repo; the release script expects
  `../../Graviton-Releases/upload-release.sh`
- Developer ID cert in the login keychain, and the `graviton-notarytool` profile — set up
  per IDENTITY.md
