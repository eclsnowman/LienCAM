# Source-bound multilingual freshness (WO-2942)

`tools/i18n-freshness.mjs` is an offline, read-only catalog report. It does not
change translations, runtime loading/fallback, machine behavior, translation
notices, images, the wiki, or the work-order queue. English is canonical.
This is the tracking foundation of `docs/process/MULTILINGUAL-MAINTENANCE.md`.

## Commands

From a Windows checkout, these are PowerShell 5.1 commands. Use the
equivalent current worktree directory for a work branch. Redirections below
create local report files only. The tool writes nothing except `--write-runtime`
(WO-2943), which writes `src/i18n/freshness/stale.json`.

```powershell
Set-Location "C:\path\to\LienCAM"
node tools/i18n-freshness.mjs
node tools/i18n-freshness.mjs --json
```

Before editing English or translations, save a content snapshot:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
node tools/i18n-freshness.mjs --snapshot | Out-File -Encoding utf8 ".planning\i18n-before.json"
```

After the edit, select content deltas against that snapshot:

```powershell
node tools/i18n-freshness.mjs --previous ".planning\i18n-before.json" --json
```

Generate an observation-only metadata candidate for explicitly selected keys:

```powershell
node tools/i18n-freshness.mjs --bootstrap --key language.label --key language.section --evidence "WO number and exact source revision observed"
```

`--metadata <file>` selects an alternative metadata file. Bootstrap prints the
combined candidate JSON, preserves all existing records (including stale and
obsolete records), and never overwrites the input file. It does not associate
unselected keys or declare a review. Review the candidate before saving it.

Focused verification:

```powershell
npx vitest run src/tests/tools/i18nFreshness.wo2942.test.ts
```

Reports and snapshots are deterministic for identical inputs; they contain no
wall clock or invented reviewer/source revision. Snapshot identity is a content
identity; record the Git source revision alongside saved evidence when needed.
PowerShell may prepend a UTF-8 BOM; JSON inputs accept it.

## Source extraction and fingerprints

Discovery follows `catalogs.ts`: one locale exists when its directory contains
at least one `*.ts` area catalog. There is no language roster here. This reports
the local checkout only; absent sibling-branch locales are not a global claim.
The current branch contains en/de. Spanish/French and WO-2940 integration are
separate work; discovery will include those catalogs when actually present.

The tool uses the existing `help-to-wiki.mjs` transpile/isolated-module-cache
pattern, calling the real registry's `loadEnglishHelpCatalog()` and category
loaders. It supports typed TS exports, computed properties and local TS imports;
it does not regex-parse imported source or initialize the app/i18next. Runtime
imports must resolve to TS modules within `src/help` or `src/i18n/locales`.
Unsupported imports and malformed trees fail with the file/import or key that
needs attention. No network provider, dependency, build output or loader hook.

Keys are full runtime lookup paths, `area.group.key`, including `help.*`.
Flattened collisions and non-string leaves are errors. SHA-256 uses UTF-8
`JSON.stringify` of recursively key-sorted objects (array order preserved):

- Translation fingerprint: the exact string, including whitespace.
- English-source fingerprint: `{text, context}`. Context is null for UI and
  non-positional Help keys. For each positional Help section leaf, context is
  `{section, heading}` from the actual English topic. The nearest preceding
  heading is included; section kinds, steps, column/row/cell order and structural
  data are retained. A change invalidates all leaves in that section, and a
  heading meaning change affects its block. Unrelated sections stay reusable.

This deliberately conservative section unit prevents equal cell text being
reassociated with a different table column or identical paragraph text being
reused across warning/heading changes. A pure topic-list reorder with stable
topic ids and unchanged content needs no invalidation. Reordering byte-identical
sections within the same heading has no observable content difference. Stable
semantic Help ids remain future work; no Help source rewrite is hidden here.

## Metadata contract (schemaVersion 1)

`associations.json` holds `entries[language][fullKey]` records:

```json
{
  "sourceFingerprint": "exact snapshot.source[key].fingerprint",
  "translationFingerprint": "exact snapshot.translations[language][key].fingerprint",
  "provenance": { "kind": "source-associated", "evidence": "WO/revision and actual association decision" },
  "review": { "status": "unreviewed" }
}
```

The checked-in pilot has three `bootstrap-observed` records, with the source
revision actually observed and `unreviewed` status. Matching observations alone
remain `translation-unverified`: they prove neither that an existing translation
was written for this English nor that it is linguistically correct. Untracked
translations are also unverified. Missing metadata is valid partial coverage.

An actual translation/update decision may record `source-associated` with both
exact fingerprints and evidence. This can be current-source coverage while
still unreviewed. Do not bulk-promote bootstrap records merely because hashes
match. An actual linguistic review independently records the exact contents
reviewed, using the snapshot at the review decision:

```json
{
  "status": "reviewed",
  "reviewer": "actual identity",
  "evidence": "actual review record for these contents",
  "sourceFingerprint": "snapshot.source[key].fingerprint at review",
  "translationFingerprint": "snapshot.translations[language][key].fingerprint at review"
}
```

These fields belong to `review`, independently of the association's fingerprints.
The source fingerprint already includes positional Help context and headings.
`reviewApplies` requires review evidence and identity, both review fingerprints
matching live contents, a current explicit source association, and clear structural
checks. Updating an association after English, translation or Help context changes
can restore `current` coverage while the retained old review stays inapplicable.
Reassociation and bootstrap never update review bindings or fabricate review evidence.

SchemaVersion 1 accepts historical/unreviewed records with either or both review
fingerprints absent. Such history stays visible but `reviewApplies` is false,
even when the association is current. Never infer missing review bindings from
an association or bulk-migrate them from a current snapshot. Only a genuine new
review decision supplies bindings and evidence for the newly reviewed contents;
retain historical evidence when recording that decision. Never invent identities.

State precedence:

| State | Meaning/action |
| --- | --- |
| obsolete | English key removed; retain translation/metadata for deliberate cleanup. |
| missing | Translation absent or blank; translate/follow up. |
| source-changed | Associated/observed English fingerprint differs, including Help context; reassociate only after updating/checking. |
| translation-unverified | No explicit association, translation changed, provenance missing, bootstrap only, or structural issue; inspect reasons. |
| current | Exact explicit source association and translation match, structural checks clear; linguistic approval remains separate. |

Rows expose both live fingerprints, `sourceMatch`, `translationMatch`, preserved
provenance, review, `reviewApplies`, reasons and structural issues. Structural
issues are reported alongside source-changed states too. Removed locales remain
visible through metadata or a previous snapshot instead of losing their debt.

## Protected text

The report compares multisets of interpolation placeholders (including duplicate
uses), i18next nesting, markup tags, inline code, common numeric G/M/T/S/F/H/D
words, modifier shortcuts, canonical controller names, known file extensions and
decimal literals. Markup tag order is checked as well. It never edits strings or
weakens existing translation tests.

Optional top-level `protectedTokens[fullKey] = ["exact literal", ...]` binds
domain-specific controller messages, macros, units, shortcut letters or other
protected text beyond the automatic patterns. Each literal's exact substring
occurrence count must match English. This foundation is not a G-code parser or
a semantic translation reviewer; automatic patterns alone do not establish full
glossary compliance. Critical instructions still require the glossary and real
independent review. All existing catalogs remain unverified here.

## WO-2943 integration contract

Exported pure inputs/outputs are JSON-serializable schemaVersion 1:

- `loadSnapshot(root)` extracts `{source, translations, files}`. Source and
  translation maps contain `{text, fingerprint}`; files lists actual loaded TS
  inputs. `makeSnapshot(englishFlat, localesFlat, contexts)` supports fixtures.
- `reportFreshness(snapshot, metadata, {previous})` emits full `rows`, per-locale
  `summary`, source `deltas` and `{language,key,state}` affected items. Without
  `previous`, affected means all outstanding maintenance. With `previous`, it
  selects source additions/removals/changes, translation edits/removals, and new
  locales, including keys already current after an intentional update.
  An unchanged snapshot selects nothing while full rows still expose backlog.
  Metadata-only changes require re-evaluating rows; they are not content deltas.
- Bootstrap is an explicit, selected-key metadata candidate operation, never a
  runtime decision. Preserve source association separately from linguistic review.

WO-2943 must define a migration policy before using these states for fallback:
unverified bootstrap material must not cause blanket English replacement. This
order deliberately supplies no runtime fallback policy or browser hash dependency.
The Node tool uses crypto/TS/VM and must not be imported into the browser bundle.

For existing `tools/help-followup.mjs`/`tools/help-staleness.mjs` integration,
use affected `help.topics.<id>.*` keys to select mapped topics, then the existing
Help map and capture manifest to select pictures/wiki candidates. UI areas must
be mapped to their existing source/surface dependencies by that order; a text
delta is not proof of pixel drift. Do not infer a per-view/locale screenshot
association from `snapshot.files`, which is whole-extraction input provenance.
No new queue, watcher, notice system or asset database is created in WO-2942.
The offline wiki stays English. Independent audit/review remains owed before
landing; this worker does not claim their verdicts.

## Runtime fallback and follow-up (WO-2943)

Migration policy. Every translated de/es/fr key carries a `bootstrap-observed`,
`unreviewed` record of the English and translation it was seen with at
4a0f9414 (WO-2943). That is an observation, not an association or a review:
those rows stay `translation-unverified` and keep showing. Only a key whose
English moves after its record turns `source-changed`, and only those fall back.

- `stale.json` is the browser's only input: per language, the `source-changed`
  keys. `runtime.ts` (browser-safe, no hashing) drops them from a language's
  catalog in `applyLanguage`, so i18next shows English for them, in the UI and
  in Help (the Help lookup reads the same bundles). English is never touched.
- Regenerate after editing English or a translation, and in the same order
  update the translations or leave the fallback deliberately:

```powershell
node tools/i18n-freshness.mjs --write-runtime   # writes src/i18n/freshness/stale.json (UTF-8)
node tools/i18n-freshness.mjs --check-runtime   # exit 1 when stale.json is out of date
```

  `src/tests/i18n/runtimeFreshness.wo2943.test.ts` fails the same way, so a
  changed English label cannot land with an old list in that slice.
- A new translation takes its own record: `--bootstrap --all` (observation of
  every translated key not yet recorded) or an explicit `source-associated`
  record when someone actually translated it against that English. Bootstrap
  output keeps one record per line (`formatMetadata`).
- After updating a stale translation, record that decision and regenerate; the
  key shows the translation again:

```powershell
node tools/i18n-freshness.mjs --associate --language de --key language.label --evidence "WO-x: translated against the new English" | Out-File -Encoding utf8 ".planning\associations.json"
```

  Review the candidate, copy it over `associations.json`, then `--write-runtime`.
  A kept earlier review stays visible but no longer applies.
- A brand-new language's first `--previous` run selects all its keys (WO-2942
  treats a new locale as wholly affected). That is the one whole-language case.

Follow-up per key and language, through the existing Help/wiki follow-up:

```powershell
node tools/i18n-freshness.mjs --snapshot | Out-File -Encoding utf8 ".planning\i18n-before.json"
# ...edit English or translations...
node tools/help-followup.mjs --i18n-previous ".planning\i18n-before.json" [--file]
```

It lists, for the English deltas, the Help topics, English wiki pages and
English pictures that show those words, and per language the keys to translate,
the keys now showing English, the Help topics touched and that language's own
pictures. A UI key reaches pictures through the product files that read its area
and name the key (every reader of the area when the key is computed), then the
existing surface map. Pictures belong to the manifest's `defaultLocale` (`en`)
unless an image names its own `locale`; `neutral` diagrams are never re-shot for
words. Nothing is selected for unchanged content, and no snapshot means no run:
there is no whole-language sweep. `--file` adds the result to the one held
help-wiki follow-up order, owned paths included; the same delta is filed once.
The wiki stays English.
