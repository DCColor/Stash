#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
BUCKET="graviton"
PRODUCT="stash"
DMG_NAME="Stash_${VERSION}_aarch64.dmg"
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
npm run tauri build -- --bundles app
echo "  done"

echo ""
echo "Creating DMG..."
mkdir -p "src-tauri/target/release/bundle/dmg"
TMP_DIR=$(mktemp -d)
cp -r "$APP_PATH" "$TMP_DIR/Stash.app"
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
