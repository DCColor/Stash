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
3. Uploads the DMG to R2 `graviton/stash/current/`
4. Archives it to `graviton/stash/archive/<version>/`
5. Writes a manifest.json

## R2 Output Structure
graviton/stash/
current/
Stash_<version>universal.dmg
manifest.json
archive/
<version>/
Stash<version>_universal.dmg

## Download URL

After release, the DMG is available at:
- `https://releases.graviton.tools/stash/mac`
- `https://releases.graviton.tools/stash/manifest`

## Version

Bump version in `src-tauri/tauri.conf.json` before releasing.

## Code Signing

Not yet configured. Testers should right-click → Open to bypass Gatekeeper on first launch.
