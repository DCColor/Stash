#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
PRODUCT="stash"   # R2 keys are the uploader's business now, so no bucket name lives here
# Graviton naming convention: <App>-<version>-<arch>.<ext> (DISTRIBUTION.md).
# The old Stash_<version>_universal.dmg was a lie after the Intel drop — the build is
# arm64-only. Set explicitly here rather than left to a Tauri default: this script builds
# the DMG with hdiutil (Tauri's bundle_dmg.sh is broken on macOS 26), so this IS the config.
#
# ⚠️ DMG_PATH must match the `stash)` case block in Graviton-Releases/upload-release.sh
# verbatim — it declares release/bundle/dmg/Stash-${VERSION}-arm64.dmg, resolved relative
# to the uploader's working directory, which is this repo root (where package.json is read
# from). Hence a repo-root release/ rather than somewhere under src-tauri/target/, matching
# the release/mac/... convention the Electron products use.
DMG_NAME="Stash-${VERSION}-arm64.dmg"
APP_PATH="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Stash.app"
DMG_PATH="release/bundle/dmg/${DMG_NAME}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Stash v${VERSION} — Build & Release"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "Pushing to GitHub..."
git add .
git commit -m "Release v${VERSION}" || echo "Nothing to commit"
git push
echo "  done"

echo ""
echo "Building Stash.app..."
npm run tauri build -- --bundles app --target aarch64-apple-darwin
echo "  done"

if [ ! -d "$APP_PATH" ]; then
  echo "ERROR: $APP_PATH does not exist — build did not produce a bundle"
  exit 1
fi

if [ -n "$(find "$APP_PATH" -maxdepth 0 -mmin +5)" ]; then
  echo "ERROR: $APP_PATH is more than 5 minutes old — likely a stale bundle from a previous build"
  echo "Delete src-tauri/target/aarch64-apple-darwin/release/bundle and re-run"
  exit 1
fi

# ── Notarize and staple the .app FIRST ────────────────────────────────────────────────────
# Order is the whole point. This used to create the DMG, notarize and staple the DMG, and
# only then staple $APP_PATH — the ORIGINAL bundle, not the copy already sealed inside the
# DMG. The shipped app therefore had no ticket: published 0.5.7 reports "Stash.app does not
# have a ticket stapled to it" when validated from a mounted DMG, while the DMG itself
# validates. Stapling is a write INTO the bundle, so it has to happen before the copy.
#
# Manifold (stacks/swift.md) notarizes the DMG only and gets away with it; a Tauri .app that
# users drag out of the DMG needs its own ticket to launch on a machine with no network.
# notarytool will not accept a bare .app — it takes a zip, dmg, or pkg — so the bundle is
# zipped for submission and the ticket is stapled to the bundle itself afterwards.
echo ""
echo "Notarizing Stash.app..."
APP_ZIP=$(mktemp -d)/Stash.zip
# ditto, not zip: it preserves the extended attributes and symlinks a signed bundle depends on.
ditto -c -k --keepParent "$APP_PATH" "$APP_ZIP"
xcrun notarytool submit "$APP_ZIP" \
  --keychain-profile graviton-notarytool \
  --wait
rm -rf "$(dirname "$APP_ZIP")"
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"
echo "  done: Stash.app stapled"

echo ""
echo "Creating DMG..."
mkdir -p "$(dirname "$DMG_PATH")"
TMP_DIR=$(mktemp -d)
# ditto rather than cp -r: cp can drop extended attributes, and the stapled ticket must
# survive into the copy that ships.
ditto "$APP_PATH" "$TMP_DIR/Stash.app"
ln -s /Applications "$TMP_DIR/Applications"
hdiutil create \
  -volname "Stash" \
  -srcfolder "$TMP_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"
rm -rf "$TMP_DIR"
echo "  done: $DMG_NAME"

echo ""
echo "Notarizing DMG..."
xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile graviton-notarytool \
  --wait
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
echo "  done"

# ── Verify the ticket on the app that actually ships ──────────────────────────────────────
# Validating $APP_PATH proves nothing about the DMG's contents. Mount it and check the copy.
echo ""
echo "Verifying stapled .app inside the DMG..."
MOUNT_DIR=$(mktemp -d)
hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_DIR" >/dev/null
staple_ok=0
if xcrun stapler validate "$MOUNT_DIR/Stash.app" \
   && codesign --verify --deep --strict "$MOUNT_DIR/Stash.app" \
   && spctl --assess --type exec -vv "$MOUNT_DIR/Stash.app"; then
  staple_ok=1
fi
hdiutil detach "$MOUNT_DIR" >/dev/null
rmdir "$MOUNT_DIR"
if [ "$staple_ok" -ne 1 ]; then
  echo "ERROR: the .app inside $DMG_NAME is not stapled, not signed, or not accepted by Gatekeeper"
  exit 1
fi
echo "  done: .app inside the DMG validates"

# ── Publish via the shared uploader ───────────────────────────────────────────────────────
# This script used to upload to current/ and archive/ itself and hand-write the manifest.
# That manifest emitted "assets": { "mac": ... } and no "notes" — neither is the contract in
# DISTRIBUTION.md, which requires the platform key mac-arm64 and a notes array. It resolved
# only because the Worker's PLATFORMS list still carries a legacy 'mac'. Accident, not
# contract, and it drifted the moment the schema moved.
#
# The uploader owns all of it now: version from package.json, upload to current/ and
# archive/<version>/, notes parsed from RELEASE_NOTES.md, a schema-correct manifest, and a
# prune of superseded files from current/. The manifest cannot drift again because nothing
# here writes one.
UPLOAD_SCRIPT="../../Graviton-Releases/upload-release.sh"
if [ ! -f "$UPLOAD_SCRIPT" ]; then
  echo "ERROR: shared uploader not found at $UPLOAD_SCRIPT"
  echo "Graviton-Releases must be checked out alongside this repo."
  exit 1
fi

echo ""
bash "$UPLOAD_SCRIPT" "$PRODUCT"

# ── Verify the manifest that is actually being served ─────────────────────────────────────
# DISTRIBUTION.md: the uploader asserts filenames it never checks, so a release can appear to
# succeed while publishing a manifest naming a file that is not there. Manifold is the only
# product that catches this. Five attempts, three seconds apart, cachebusted for the edge.
echo ""
echo "Verifying published manifest..."
verified=0
for attempt in 1 2 3 4 5; do
  BODY=$(curl -sSL "https://releases.graviton.tools/${PRODUCT}/manifest?cachebust=$(date +%s)-${attempt}" || true)
  if MF_BODY="$BODY" MF_WANT_VERSION="$VERSION" MF_WANT_ASSET="$DMG_NAME" python3 -c '
import json, os, sys
try:
    m = json.loads(os.environ["MF_BODY"])
except Exception:
    sys.exit(1)
sys.exit(0 if m.get("version") == os.environ["MF_WANT_VERSION"]
         and m.get("assets", {}).get("mac-arm64") == os.environ["MF_WANT_ASSET"]
         else 1)
'; then
    verified=1
    break
  fi
  echo "  attempt ${attempt}: manifest does not yet name ${VERSION} / ${DMG_NAME}"
  sleep 3
done
if [ "$verified" -ne 1 ]; then
  echo "ERROR: published manifest never named version ${VERSION} with mac-arm64 ${DMG_NAME}"
  echo "Last response: $BODY"
  exit 1
fi
echo "  done: manifest names ${VERSION} / mac-arm64 → ${DMG_NAME}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Done! Stash v${VERSION} is live."
echo ""
echo "  Download: https://releases.graviton.tools/stash/mac-arm64"
echo "  Manifest: https://releases.graviton.tools/stash/manifest"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
