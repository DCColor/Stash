#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
BUCKET="graviton"
PRODUCT="stash"

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
echo "Building Stash..."
npm run tauri build
echo "  done"

DMG=$(find src-tauri/target -name "*.dmg" | head -1)
if [ -z "$DMG" ]; then
  echo "No DMG found after build — check build output"
  exit 1
fi
DMG_NAME=$(basename "$DMG")
echo "  found: $DMG_NAME"

echo ""
echo "Uploading to R2..."
wrangler r2 object put ${BUCKET}/${PRODUCT}/current/${DMG_NAME} \
  --file "$DMG" --remote
echo "  done: current/${DMG_NAME}"

wrangler r2 object put ${BUCKET}/${PRODUCT}/archive/${VERSION}/${DMG_NAME} \
  --file "$DMG" --remote
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
