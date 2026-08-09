#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
BUCKET="graviton"
PRODUCT="stash"
DMG_NAME="Stash_${VERSION}_universal.dmg"
APP_PATH="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Stash.app"
DMG_PATH="src-tauri/target/release/bundle/dmg/${DMG_NAME}"

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

echo ""
echo "Uploading to R2..."
wrangler r2 object put ${BUCKET}/${PRODUCT}/current/${DMG_NAME} \
  --file "$DMG_PATH" --remote
echo "  done: current/${DMG_NAME}"

wrangler r2 object put ${BUCKET}/${PRODUCT}/archive/${VERSION}/${DMG_NAME} \
  --file "$DMG_PATH" --remote
echo "  done: archive/${VERSION}/${DMG_NAME}"

echo ""
echo "Writing manifest..."
UPDATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > /tmp/stash-manifest.json << MANIFEST
{
  "product": "stash",
  "version": "${VERSION}",
  "updated": "${UPDATED}",
  "assets": {
    "mac": "${DMG_NAME}"
  }
}
MANIFEST

wrangler r2 object put ${BUCKET}/${PRODUCT}/current/manifest.json \
  --file /tmp/stash-manifest.json \
  --content-type application/json \
  --remote
rm /tmp/stash-manifest.json
echo "  done: manifest.json"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Done! Stash v${VERSION} is live."
echo ""
echo "  Download: https://releases.graviton.tools/stash/mac"
echo "  Manifest: https://releases.graviton.tools/stash/manifest"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
