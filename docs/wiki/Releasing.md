# Releasing

How an export and a tagged release are made, at the level a contributor needs. Only maintainers publish; this page is so you know what happens to your change afterwards.

## What gets published

The public repository is produced from the development tree by a script, not by copying folders. A manifest, `tools/release/manifest.json`, lists what is included and what is left out, in order.

```
node tools/release/export-public.mjs <commit> <output-folder>
```

The script exports the chosen commit into the folder using that manifest and then runs the scan.

## The scan

`tools/release/scan.mjs` checks an exported folder for things that must not be public: personal names and paths, local machine addresses, oversized or unexpected binary files, and names of commercial products. A release goes out only when the scan reports no hits.

```
node tools/release/scan.mjs <folder>
```

## Generated files

Some public files are generated from one source so they cannot drift:

- `CREDITS.md` comes from `src/about/credits.json` through `tools/release/credits.mjs`.
- The wiki pages for the application's Help topics come from `src/help/` through `npm run wiki:generate`. The wiki is not edited by hand on GitHub; fix the source file and it is regenerated.

## Tagging and the release

1. The version in `package.json` is set and `CHANGELOG.md` is updated.
2. The build and the public tests pass: `npm run build` and `npm run test:public`.
3. The export is made and scanned clean.
4. A tag is pushed. Alpha releases are marked as pre-releases.
5. Installers for Windows, Linux and macOS are built with the `package:` scripts in `package.json`, checksums are written, and release notes are published on GitHub Releases, including the known limitations.
6. The project site and the live demo are rebuilt from the tag, and the wiki is regenerated.

## Hardware caveats

Release notes and the controller pages say plainly which machines have been tested on real hardware. See [Known limitations](Known-Limitations). Test reports from your own machine are the most useful contribution there is.
