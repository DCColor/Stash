# Stash — Build & Release Guide

**Repo:** https://github.com/DCColor/Stash
**R2 bucket:** `graviton/stash/`

## Release

```bash
npm run release
```

This single command:
1. Commits and pushes all changes to GitHub
2. Builds the Mac app via `npm run tauri build`
3. Signs the .app with the Graviton Developer ID certificate
4. Creates a DMG via `hdiutil` (bypasses Tauri's broken `bundle_dmg.sh` on macOS 26 beta)
5. Notarizes and staples the DMG and .app via Apple notarytool
6. Uploads the DMG to R2 `graviton/stash/current/`
7. Archives it to `graviton/stash/archive/<version>/`
8. Writes a manifest.json

## R2 Output Structure

graviton/stash/
  current/
    Stash_<version>_universal.dmg
    manifest.json
  archive/
    <version>/
      Stash_<version>_universal.dmg

## Download URL

After release, the DMG is available at:
- `https://releases.graviton.tools/stash/mac`
- `https://releases.graviton.tools/stash/manifest`

## Version

Bump version in all three files before releasing:
- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

```bash
sed -i '' 's/"version": "OLD"/"version": "NEW"/' package.json src-tauri/tauri.conf.json
sed -i '' 's/^version = "OLD"/version = "NEW"/' src-tauri/Cargo.toml
```

## Code Signing

Uses the shared Graviton signing infrastructure. See `SIGNING.md` for full details.

| Item | Value |
|---|---|
| Certificate | Developer ID Application: Amigo Media LLC (8UQ7MDM87B) |
| Notarization profile | `graviton-notarytool` |
| Entitlements | `src-tauri/entitlements.plist` |

Signing requires:
- Developer ID Application cert installed in login keychain
- Notarization credentials stored via `xcrun notarytool store-credentials "graviton-notarytool"`

## Architecture

Builds arm64 only (Apple Silicon). Intel support dropped as of 0.5.8.
Requires: `rustup target add aarch64-apple-darwin`

NOTE: DMG_NAME in `scripts/build-and-release.sh` still produces `_universal.dmg` — this is
intentionally unchanged pending alignment with the Graviton-Releases pipeline. The
filename and the manifest asset keys need to move together, not separately.

## Verifying a Signed Build

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Stash.app
xcrun stapler validate /Applications/Stash.app
spctl --assess --type exec -vvv /Applications/Stash.app
```

Expected results:
- codesign: "valid on disk" and "satisfies its Designated Requirement"
- stapler: "The validate action worked!"
- spctl: "accepted, source=Notarized Developer ID, origin=Developer ID Application: Amigo Media LLC (8UQ7MDM87B)"

## Known Issues

### DMG volume icon not showing
The DMG mounts without a custom icon. `SetFile` and `Rez` (required to embed icns in a DMG) need Xcode's additional tools package. Fix pending — app icon shows correctly in Applications folder.

### bundle_dmg.sh fails on macOS 26 beta
Tauri's built-in DMG bundler (`bundle_dmg.sh`) fails on macOS 26 with "Not enough arguments". Workaround: build with `--bundles app` to get the `.app` only, then create the DMG manually via `hdiutil`. This is handled automatically by `scripts/build-and-release.sh`.

## Prerequisites (one-time setup)

- Rust installed (`rustup`)
- Rust target: `rustup target add aarch64-apple-darwin`
- Node.js 22+
- Wrangler authenticated via OAuth (`wrangler login`)
- Developer ID cert in keychain
- Notarization profile: `xcrun notarytool store-credentials "graviton-notarytool" --apple-id "robbie@graviton.tools" --team-id "8UQ7MDM87B"`
