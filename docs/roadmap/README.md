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

Lifecycle fields (internal, WO-2985; `tools/release/roadmap.mjs` validates them and never renders them):

- `links` - `orders` (WO ids: a cache of the orders' own `roadmap:` lists), `requests` (`issue-<n>`,
  `discussion-<n>`), `supersededBy` (the surviving R-number; the row leaves the public list but stays in the
  file), `duplicates` (other R-numbers).
- `decisions` - the operator's decisions: `{ ref, at, words, by }`, where `ref` is the card id or owner-export item.
- `history` - append-only `{ at, by, ... }` entries (`move`, `from`, `to`, `reason`, `evidence`). A correction
  is a new entry; an earlier one is never edited.

Only `tools/roadmap/lifecycle.mjs` writes these fields (and `status` from here on). Design: see work order WO-2961 (roadmap lifecycle).

## How an order links to a row

An order's frontmatter names the rows it serves. The order file is the authority; `links.orders` is the cache.

```yaml
roadmap: [R-018]                         # contributes: moves the row to In progress at most
roadmap: [{id: R-018, delivers: true}]   # delivers: the row is on main once every delivering order has landed
```

An order that landed in a way git cannot recognise names its commit in `landing-commit: <sha>`
(the tool otherwise finds "Land WO-x", "WO-x: land", a merge of `wo/WO-x`, or a landing record on main).

## Lifecycle

The public status of a row with linked orders is derived, never typed: from the decisions, the linked orders'
states, and git (landing commit reachable from main; reachable from a published `release/rc-*` branch).

| Stage | Reached by | Public word |
|---|---|---|
| idea | new row; `defer` | Idea |
| approved | the operator's `approve`; `reopen` | Planned |
| ordered | an order lists the row: started (leased, architect, review, audit, ready-to-land) or a landed contributing order | In progress |
| ordered | only queued or held orders | Planned |
| on main | every delivering order landed and its commit is on main | In progress |
| released | every delivering landing commit is on a published release branch | the operator's word (`mature`): Experimental, Alpha or Done |
| declined | the operator's `decline` (reason goes in `note`; open orders are closed first) | Declined |
| superseded | `supersede --to R-nnn` | hidden; kept in the file |

Filed, approved, leased or worker-completed is never delivered. A failed or retired order contributes nothing.
A row the operator gave a shipped word keeps it until he reopens it; a reopen sets aside the orders that delivered the
row before it, so the row is Planned until a new order is linked. Derivation is a pure function, so replays and
out-of-order events give the same answer. A replayed decision (same move, same card) changes nothing, and a
decision dated before one already applied is recorded with no effect, so the stored status follows the
latest-dated decision whatever order they arrive in.

```
node tools/roadmap/lifecycle.mjs derive      # rows whose derived status differs (prints only)
node tools/roadmap/lifecycle.mjs links       # links.orders cache vs the orders' roadmap: lists (prints only)
node tools/roadmap/lifecycle.mjs decide R-018 mature --word done --ref Q-... --by operator   # prints before/after
node tools/roadmap/lifecycle.mjs decide ... --write                                       # architect: saves roadmap.json
node tools/roadmap/reconcile.mjs --date 2026-10-20 [--ref <sha>]   # dry run of a proposals file (prints only)
node tools/roadmap/reconcile.mjs --apply --date ...                # architect, after review: writes and regenerates
```

`derive` reads published releases as every `release/rc-*` branch on origin; pass `--published <ref,...>` when
a branch is cut but its release is not yet published.

## How a feature request becomes a row

1. A request arrives as a GitHub Ideas discussion or issue.
2. On triage it gets the next R-number (highest id plus one), or is merged into an existing row.
3. Add the row with status `idea`, a goal in plain words, and no commercial CAM product names.
4. Run `node tools/release/roadmap.mjs` and commit `roadmap.json`, `ROADMAP.md` and `site/roadmap.html` together.
5. Comment on the GitHub idea with the R-number and a link to the roadmap.
6. Link the orders that build it (`roadmap:` in the order frontmatter). The status follows the orders and git
   (`lifecycle.mjs derive`); the operator's decisions and shipped words go in through `lifecycle.mjs decide`.
   A declined idea stays, with the reason in `note`.
