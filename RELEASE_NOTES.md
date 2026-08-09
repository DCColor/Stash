# Stash — Release Notes

Published with each release. `scripts/build-and-release.sh` hands this file to the shared
uploader, which parses the section matching the version being released and puts the entries
into the R2 manifest as a `notes` array. Keep entries short — they render in an update
prompt, not on a changelog page. Format notes are at the bottom.

## 0.5.8

- New Dates tab: view a file's created and modified timestamps, and set them.
- Clip shortcuts paste directly into the app you were last in.
- Pinned clips are capped, and the order you lock them in survives a restart.
- The update check works again — it was blocked in every packaged build, so Stash always claimed to be up to date.
- Apple Silicon only. Intel Macs should stay on 0.5.7.

## 0.5.7

- Last universal build, running natively on both Intel and Apple Silicon.

---

# Format

A release section is a level-2 heading whose text is the version, followed by bullets:

> `## 0.5.8`
> `- One short line per entry.`
> `- Another entry.`

Rules the parser enforces:

- The heading must match the `version` in `package.json` exactly. A `v` prefix is accepted.
- Entries are `-` or `*` bullets, collected until the next heading of level 1 or 2.
- One line per entry. A bullet wrapped onto a second line loses everything after the wrap.
- Anything in the section that is not a bullet — prose, sub-headings — is ignored.
- Fenced code blocks are stripped before parsing, so an example section inside one cannot be
  mistaken for a real one.
- A missing or empty section warns but does not fail the release; the manifest then ships
  `"notes": []` and the update prompt shows a bare version number.
