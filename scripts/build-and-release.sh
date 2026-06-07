#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
BUCKET="graviton"
PRODUCT="stash"
DMG_NAME="Stash_${VERSION}_universal.dmg"
APP_PATH="src-tauri/target/release/bundle/macos/Stash.app"
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
export APPLE_KEYCHAIN_PROFILE=graviton-notarytool
npm run tauri build -- --bundles app --target universal-apple-darwin
echo "  done"

echo ""
echo "Signing app..."
codesign --force --deep --sign "Developer ID Application: Amigo Media LLC (8UQ7MDM87B)" \
  --entitlements src-tauri/entitlements.plist \
  --options runtime \
  "$APP_PATH"
echo "  done"

echo ""
echo "Creating DMG..."
mkdir -p "src-tauri/target/release/bundle/dmg"
TMP_DIR=$(mktemp -d)
cp -r "$APP_PATH" "$TMP_DIR/Stash.app"
ln -s /Applications "$TMP_DIR/Applications"
# Set volume icon
cp "src-tauri/icons/icon.icns" "$TMP_DIR/.VolumeIcon.icns"
SetFile -a C "$TMP_DIR" 2>/dev/null || true
hdiutil create \
  -volname "Stash" \
  -srcfolder "$TMP_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"
rm -rf "$TMP_DIR"
# Set icon on DMG itself
DeRez -only icns "src-tauri/icons/icon.icns" > /tmp/icns.rsrc
Rez -append /tmp/icns.rsrc -o "$DMG_PATH"
SetFile -a C "$DMG_PATH" 2>/dev/null || true
rm /tmp/icns.rsrc
echo "  done: $DMG_NAME"

echo ""
echo "Notarizing..."
xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile graviton-notarytool \
  --wait
xcrun stapler staple "$DMG_PATH"
xcrun stapler staple "$APP_PATH"
echo "  done"

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
