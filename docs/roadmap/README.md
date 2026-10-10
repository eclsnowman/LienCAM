# Roadmap source

`roadmap.json` is the one source of the public roadmap. `node tools/release/roadmap.mjs` writes
`ROADMAP.md` (repo root) and `site/roadmap.html` from it. Never edit those two files by hand; each
carries a "generated from docs/roadmap/roadmap.json - edit that file" line.
`node tools/release/roadmap.mjs --check` exits 1 when either is stale.

## Row fields

- `id` - R-nnn, never reused. `theme` - one of the `themes` list. `item`, `goal` - public text.
- `status` - one of: idea, planned, in progress, alpha, experimental, done, declined.
- `note` - plain status text shown under the status word. Public.
- `priority` - 1 (next after the alpha), 2 (after that), 3 (later), `"idea"`, or null (done).
- `source`, `size`, `priorityNote` - internal, kept for the maintainers, never shown on the public pages.

## How a feature request becomes a row

1. A request arrives as a GitHub Ideas discussion or issue.
2. On triage it gets the next R-number (highest id plus one), or is merged into an existing row.
3. Add the row with status `idea`, a goal in plain words, and no commercial CAM product names.
4. Run `node tools/release/roadmap.mjs` and commit `roadmap.json`, `ROADMAP.md` and `site/roadmap.html` together.
5. Comment on the GitHub idea with the R-number and a link to the roadmap.
6. Move the status as work lands (planned, in progress, alpha, done). A declined idea stays, with the reason in `note`.
