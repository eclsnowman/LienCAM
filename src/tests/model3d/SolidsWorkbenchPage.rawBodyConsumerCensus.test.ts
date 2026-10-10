// @vitest-environment node
//
// WO UI-51A-R2 (audit MAJOR, CLASS CLOSURE -- the standing rule quoted
// verbatim in the WO: "a pick-safety fix that lands on ONE pick surface
// while a sibling surface keeps the unsafe path is a mis-fix. Close the
// CLASS, not the instance."): the R1 audit's Boolean bypass existed because
// bodyFeatureIds(dag)/availableBodies/bodyHandlesRef.current.get are RAW --
// they include superseded ancestors whose kernel handle is deliberately
// RETAINED for fast undo (liveBodyFeatureIds' own header comment) -- and one
// consumer (the standalone Boolean picker) forgot to filter through the
// live-body set before this WO. This is the derived completeness census the
// WO ordered: every call site in SolidsWorkbenchPage.tsx that touches one of
// the three raw sources is enumerated by an AST scan (alias/re-export proof
// against the heal-result-consumer-census precedent's own method) and must
// be classified LIVE-FILTERED (a live-set membership check governs whether
// the site's id/body can be reached) or RAW-BY-DESIGN (a one-line reason a
// superseded handle is legitimate there -- undo/history/disposal bookkeeping,
// or a read-only inspection surface). An unclassified site fails BY NAME, so
// a future FOURTH raw picker cannot ship the same leak silently.
//
// WO UI-51A-R3 (audit MAJOR 2, disclose-and-pass): a RAW-BY-DESIGN reason
// that merely DISCLOSES an unresolved same-class-unsafe consumer (rather than
// either resolving it or proving, with a cited test, that resolving the
// historical body is intentionally correct) is NOT a legitimate exception --
// it is the census passing with a known leak. The mechanical
// no-disclosure-language test below enforces this: "disclosed"/"disclosure"
// in any reason is a hard FAIL, not a valid RAW-BY-DESIGN escape hatch.
//
// No dialog component (BooleanDialog.tsx, ExtrudeDialog.tsx, etc. -- "any
// component it feeds") references bodyHandlesRef/bodyFeatureIds/
// availableBodies directly (verified: `grep -rl` over src/components/model3d/
// dialogs returns nothing) -- they only ever receive a `bodyOptions` prop
// from this file, so the census scope is this ONE file.

import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE_PATH = fileURLToPath(new URL('../../components/model3d/SolidsWorkbenchPage.tsx', import.meta.url))

type SiteKind = 'bodyHandlesRef.get' | 'bodyFeatureIds()' | 'availableBodies'
interface Site {
  kind: SiteKind
  line: number
  text: string
}

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  ts.forEachChild(node, (child) => walk(child, cb))
}

/** Alias-resolving per the heal-result-consumer-census precedent: local
 *  binding names of `name` reached via a plain OR aliased named import. This
 *  file's three raw sources are all module-local (bodyFeatureIds/
 *  bodyHandlesRef declared once, no re-export), so only the plain-identifier
 *  form is possible today -- the alias machinery is kept anyway so a future
 *  refactor that DOES alias/destructure one of them cannot silently evade
 *  the census (see the evasion-fixture test below, which proves the scan
 *  actually resolves an alias rather than only ever matching the literal
 *  token). */
function collectAliases(sf: ts.SourceFile, name: string): Set<string> {
  const aliases = new Set<string>([name])
  walk(sf, (node) => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const el of node.importClause.namedBindings.elements) {
        const orig = el.propertyName?.text ?? el.name.text
        if (orig === name) aliases.add(el.name.text)
      }
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.name && ts.isObjectBindingPattern(decl.name)) {
          for (const el of decl.name.elements) {
            const prop = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName)) ? el.propertyName.text : undefined
            const local = ts.isIdentifier(el.name) ? el.name.text : undefined
            if (prop === name && local) aliases.add(local)
            else if (!prop && local === name) aliases.add(local)
          }
        }
      }
    }
  })
  return aliases
}

type Verdict = 'LIVE-FILTERED' | 'RAW-BY-DESIGN'
interface Classification {
  verdict: Verdict
  reason: string
}

// Keyed by `${kind}::${trimmed source line}` -- robust to line-number drift
// elsewhere in this 6000+ line file (a genuine edit of the CLASSIFIED line
// itself, not an unrelated insertion above it, is what should force
// reclassification). A site whose (kind, text) is not a key here fails BY
// NAME in the test below.
const CLASSIFICATIONS: Record<string, Classification> = {
  // IMPORT-FANOUT-HEADLESS: liveBodyFeatureIds' OWN definition (its internal
  // `const ids = bodyFeatureIds(dag)` superset walk) was lifted verbatim OUT of
  // this file into bodyLineage.ts so the workbench regen gather and the headless
  // model-body replay share one implementation. It is the DEFINITION of the
  // live/raw split, not a consumer pick surface, and now lives outside this
  // census's single-file scope -- so it no longer needs a classification here.

  // --- refreshBodiesList (Bodies panel): raw for LINEAGE labels ("F2 (was F1)"), live rows filtered separately.
  'bodyFeatureIds()::const bodyIds = bodyFeatureIds(dag)#refreshBodiesList':
    { verdict: 'RAW-BY-DESIGN', reason: 'refreshBodiesList needs the raw superset to derive lineage ("F2 (was F1)") via projectBodyLineages; the panel ROWS use the separately-computed liveIds. Proven by SolidsWorkbenchPage.bodyListPanel.test.tsx "UI-28: a fillet keeps the original body identity and UI-4 bridge history while every row action targets the live leaf".' },
  'bodyHandlesRef.get::const handle = bodyHandlesRef.current.get(id)':
    { verdict: 'LIVE-FILTERED', reason: 'id is drawn from `liveIds` (liveBodyFeatureIds), computed immediately above this loop in the same function (refreshBodiesList and the WO UI-58 resize-hole verdicts fetch effect share this exact line).' },

  // --- syncCamModelBodies (INT-17A Stage 1, CAM sync): raw for LINEAGE labels only, the
  // surfaced CAM set is live-filtered. Ruling per the refreshBodiesList sibling above
  // (same projectBodyLineages pattern); classified at merge time by the architect
  // (INT-17A-R7 report, non-storage finding 1).
  'bodyFeatureIds()::const bodyIds = bodyFeatureIds(dag)#syncCamModelBodies':
    { verdict: 'RAW-BY-DESIGN', reason: 'syncCamModelBodies needs the raw superset only to derive lineage names via projectBodyLineages; the set actually surfaced to CAM is `live`, built from liveIds (liveBodyFeatureIds filtered to non-failed), computed beside it in the same function. Proven by SolidsWorkbenchPage.camModelBodies.test.tsx "projects a superseded body lineage to its sole live leaf without surfacing the retained ancestor".' },

  // --- Form "From body" (the useFormSession selectedBodyMesh dep): the body a form starts from.
  'bodyHandlesRef.get::const handle = id === null ? undefined : bodyHandlesRef.current.get(id)':
    { verdict: 'LIVE-FILTERED', reason: 'id is the selected body row only when it is in `live` (liveBodyFeatureIds, computed on the line above), else the sole live body, else null - a consumed or failed body can never be turned into a form. The conversion itself is proven by src/tests/form/formFromBody.test.ts.' },

  // --- disposal bookkeeping: own-id, not a pick.
  'bodyHandlesRef.get::const handle = bodyHandlesRef.current.get(featureId)':
    { verdict: 'RAW-BY-DESIGN', reason: 'disposeFeatureBody(featureId) disposes its own explicit deletion target, not a fresh pick. Proven by SolidsWorkbenchPage.delete.test.tsx "deleting a leaf feature disposes its viewport body and drops its tree row; undo restores the node and replays the kernel op".' },
  'bodyHandlesRef.get::const prior = bodyHandlesRef.current.get(featureId)':
    { verdict: 'RAW-BY-DESIGN', reason: 'disposePriorReplayHandle(featureId) disposes THIS node\'s own prior handle before its own replay -- own-id bookkeeping, not a pick. Proven by SolidsWorkbenchPage.handleLeak.test.tsx "disposes the prior handle before a replay, and leaves no stale handle when the replay fails".' },

  // --- measure/appearance/mass-properties (UI-4 read-only inspection suite): explicit, non-destructive.
  'bodyHandlesRef.get::const handle = bodyHandlesRef.current.get(bodyId)#snapshotsFor':
    { verdict: 'LIVE-FILTERED', reason: 'snapshotSource.snapshotsFor(bodyId) is read-only and bodyId flows only from the live-filtered liveBodyIds() pick surface. Proven by SolidsWorkbenchPage.ui13b.test.tsx "UI-4 panel suite drives the real workbench body: measure a distance, section, isolate/hide/show, appearance color, mass properties".' },
  'bodyHandlesRef.get::const handle = massBodyId !== null ? bodyHandlesRef.current.get(massBodyId) : undefined':
    { verdict: 'LIVE-FILTERED', reason: 'massBodyId is selected exclusively from massBodyCandidateIds, which is derived from liveBodyIds; the dropdown renders that same live-only id list.' },
  'bodyHandlesRef.get::!cancelled && bodyHandlesRef.current.get(massBodyId) === handle':
    { verdict: 'LIVE-FILTERED', reason: 'post-await mass-properties staleness check for the same live-filtered massBodyId and handle already resolved above; it cannot introduce a new raw candidate.' },
  'bodyFeatureIds()::for (const featureId of bodyFeatureIds(dag)) {':
    { verdict: 'RAW-BY-DESIGN', reason: 'the UI-4 bridge-sync effect intentionally retains every historical body in its inspection cache while the Bodies action surface stays on the live leaf. Proven by SolidsWorkbenchPage.bodyListPanel.test.tsx "UI-28: a fillet keeps the original body identity and UI-4 bridge history while every row action targets the live leaf".' },
  'bodyFeatureIds()::const bodyIds = bodyFeatureIds(dag)#repaintUi4Overlays':
    { verdict: 'RAW-BY-DESIGN', reason: 'repaintUi4Overlays resets cached resting presentation for every retained history body before applying live interaction overlays; it is render bookkeeping, not a pick candidate source. Proven by SolidsWorkbenchPage.bodyListPanel.test.tsx "UI-28: a fillet keeps the original body identity and UI-4 bridge history while every row action targets the live leaf".' },

  // --- CAM-1 model-reference re-resolution: WO UI-51A-R3 (audit MAJOR 2) closed the
  // consumed-but-retained leak -- `handle` alone no longer governs reachability.
  'bodyHandlesRef.get::const handle = bodyHandlesRef.current.get(bodyId)#reresolveCamModelRefs':
    { verdict: 'LIVE-FILTERED', reason: 'idsByBody keys are CAM op model-reference targets (CAM-1, docs/3d-modeling-plan.md S3.8); the site is now gated by `handle === undefined || !liveBodyIds.has(bodyId)` immediately below -- a CONSUMED-but-retained body degrades to "lost" exactly like a genuinely deleted one, proven by SolidsWorkbenchPage.camModelRefRelineage.test.tsx\'s "consumed body degrades, not silently resolves" case. Full relineage (re-pointing a ModelReference at the live descendant instead of degrading) stays a CAM-lane design question, out of this pick-safety WO\'s scope -- named as a recommended follow-up board WO in this WO\'s own report, not folded into this classification.' },

  // --- regen pass reset/re-hide pair: temporary raw reset, paired final live-checked sweep.
  'bodyFeatureIds()::for (const id of bodyFeatureIds(dag)) setFeatureVisible(id, dag.getNode(id)?.hidden !== true)':
    { verdict: 'RAW-BY-DESIGN', reason: 'WO UI-56: reset-before-regen re-derives each historical node from its own persisted `hidden` flag before the paired final live sweep re-hides superseded ids. Proven by SolidsWorkbenchPage.bodyHiddenPersist.test.tsx "boolean-undo regression guard: a boolean-consumed body becomes visible again on undo (the ORIGINAL purpose of the reset, preserved)".' },
  'bodyFeatureIds()::for (const id of bodyFeatureIds(dag)) {':
    { verdict: 'LIVE-FILTERED', reason: 'the final post-pass sweep: raw iteration with an inline live-set membership check per item (`!live.has(id)`) immediately below, same shape as every other LIVE-FILTERED site.' },

  // --- resolveProjectSource (sketch-on-face projection): raw + an explicit LIVE companion, both handed to the resolver.
  'bodyFeatureIds()::const bodyIds = bodyFeatureIds(dag)#resolveProjectSource':
    { verdict: 'RAW-BY-DESIGN', reason: 'passed into resolveProjectGeometry\'s visibility object alongside an explicit companion `liveBodyIds` Set computed on the next line, so raw ancestry never grants pick reachability. Proven by projectGeometry.test.ts "live-body independently excludes its hit".' },

  // --- push-pull / resize-hole / defeature click handlers: ownerId sourced from a live-filtered set just above.
  // WO UI-58: handleResizeHoleClick (the old modal-first flow) is DELETED -- ownerId for resize-hole
  // now comes from handleResizeHolePick's own viewport hit.bodyId (pickAcrossBodies over
  // liveBodyFeatureIds candidates, identical shape to handlePushPullPick's) or
  // handleResizeHoleListSelect's row.ownerId (itself sourced from resizeHoleLiveBodyIds, the same
  // liveBodyFeatureIds-derived set).
  // WO-110: the keyflow salvage (f3c2b92) then DELETED handleResizeHoleApply itself -- the
  // modal-era apply (which read `bodyHandlesRef.current.get(ownerId)` and re-checked it after its
  // await) was replaced by the resize-hole preview session plus its candidate transaction, whose
  // owner reads are keyed by `candidate.payload.ownerId` and classified in the resize-hole/defeature
  // adoption group below. Verified genuinely gone, not moved: `get(ownerId)` now has exactly ONE
  // occurrence in the file (handlePushPullPick), and `handleResizeHoleApply` no longer exists in
  // src/ at all. Its post-await staleness key is therefore removed rather than re-pointed.
  'bodyHandlesRef.get::const handle = bodyHandlesRef.current.get(ownerId)':
    { verdict: 'LIVE-FILTERED', reason: 'the sole remaining site with this text is handlePushPullPick, whose ownerId is hit.bodyId from pickAcrossBodies over liveBodyFeatureIds candidates resolved on the line above it.' },
  'bodyHandlesRef.get::const body = bodyHandlesRef.current.get(defeatureOwnerId)':
    { verdict: 'LIVE-FILTERED', reason: 'defeatureOwnerId is sourced from currentLiveBodyIds (liveBodyFeatureIds), computed once in render scope and reused here.' },
  'bodyHandlesRef.get::if (bodyHandlesRef.current.get(defeatureOwnerId) !== body || dag.getNode(defeatureOwnerId) === undefined) {':
    { verdict: 'LIVE-FILTERED', reason: 'handleDefeatureClick\'s own post-await staleness re-check against the handle it already live-resolved above -- not a fresh pick.' },

  // --- WO UI-58 resize-hole verdict cache: SR-2 keys resizeHoleVerdictsRef by
  // LINEAGE id (bodyLineage.ts lineageIdOf), not raw leaf id, so a direct-edit
  // apply that supersedes its owner with a new leaf id still finds its warm
  // cache entry. Every call site below passes the raw bodyFeatureIds(dag)
  // census into lineageIdOf ONLY as its ancestor-walk lookup table (see
  // lineageIdOf's own header: it starts from `leafId` and walks dag.consumes
  // parents that are members of that census -- the census never selects
  // WHICH id gets looked up, it only helps trace one already-chosen id's
  // stable identity). The leafId/leaf-owner argument at every one of these
  // sites is independently live-filtered before this call ever runs: the
  // fetch effect's `next.ownerId`/hover branch's `next.ownerId` and the click
  // handler's `hit.bodyId` both come from pickAcrossBodies(liveBodyFeatureIds(...))
  // candidates (same shape as handlePushPullPick's own live pick, classified
  // above); the list-select branch's `row.ownerId` and the two per-body-table
  // derivations' `id` all iterate resizeHoleLiveBodyIds (=currentLiveBodyIds,
  // itself liveBodyFeatureIds-derived, WO UI-58 P5 comment above). A
  // superseded-only body can therefore never reach lineageIdOf's `leafId`
  // parameter through any of these sites -- the raw census argument is
  // read-only ancestry bookkeeping, same RAW-BY-DESIGN shape already ruled
  // for refreshBodiesList/syncCamModelBodies's lineage-only raw census use above.
  'bodyFeatureIds()::const lineageCensus = bodyFeatureIds(dag)':
    { verdict: 'RAW-BY-DESIGN', reason: 'the WO UI-58 verdict-cache fetch effect uses this only as lineageIdOf\'s ancestry table; every translated id comes from liveIds. Proven by SolidsWorkbenchPage.resizeHole.test.tsx "applying a diameter change on hole A while STAYING armed invalidates the cache -- re-selecting hole A (and hole B on the same body) shows the POST-apply diameter, never the pre-apply cached verdict".' },
  'bodyFeatureIds()::? resizeHoleVerdictsRef.current.get(lineageIdOf(dag, bodyFeatureIds(dag), next.ownerId)) ?? []':
    { verdict: 'RAW-BY-DESIGN', reason: 'handlePickHover\'s next.ownerId comes from pickAcrossBodies over liveBodyFeatureIds; the raw census is only lineageIdOf\'s ancestor-walk table. Proven by SolidsWorkbenchPage.resizeHole.test.tsx "shows live geometry before history mutation, adopts that exact candidate once, stays armed, and round-trips undo/redo".' },
  'bodyFeatureIds()::const verdicts = resizeHoleVerdictsRef.current.get(lineageIdOf(dag, bodyFeatureIds(dag), hit.bodyId)) ?? []':
    { verdict: 'RAW-BY-DESIGN', reason: 'handleResizeHolePick\'s hit.bodyId comes from pickAcrossBodies over liveBodyFeatureIds; the raw census is only lineageIdOf\'s ancestor-walk table. Proven by SolidsWorkbenchPage.liveBodyPick.test.tsx "Resize hole: a post-supersede pick on the hole itself resolves to F2 (opens the anchored entry, creates a resizeHole node consuming F2), never silently misses behind F1s stale solid face".' },
  'bodyFeatureIds()::const verdicts = resizeHoleVerdictsRef.current.get(lineageIdOf(dag, bodyFeatureIds(dag), row.ownerId)) ?? []':
    { verdict: 'RAW-BY-DESIGN', reason: 'handleResizeHoleListSelect\'s row.ownerId is built from resizeHoleLiveBodyIds; the raw census is only lineageIdOf\'s ancestor-walk table. Proven by SolidsWorkbenchPage.resizeHole.test.tsx "the List affordance is reachable only from the armed state, and a row click behaves as a click-select".' },
  'bodyFeatureIds()::const census = bodyFeatureIds(dag)':
    { verdict: 'RAW-BY-DESIGN', reason: 'resizeHoleVerdictsByBody and resizeHoleFailuresByBody both map live resizeHoleLiveBodyIds and use this census only to translate each live id into its lineage cache key. Proven by SolidsWorkbenchPage.resizeHole.test.tsx "a thrown recognizeFeatures failure is surfaced BY NAME in the armed hint -- never collapsed into the same no recognized holes text an honest zero-hole body gets".' },
  'bodyFeatureIds()::const verdicts = resizeHoleVerdictsRef.current.get(lineageIdOf(dag, bodyFeatureIds(dag), ownerId)) ?? []':
    { verdict: 'RAW-BY-DESIGN', reason: 'BK-174 tree-menu Edit uses raw ancestry to translate the resizeHole feature\'s own historical owner to its current live lineage cache entry, never to select a fresh target. Proven by SolidsWorkbenchPage.resizeHole.test.tsx "tree-menu Edit... arms resize-hole, auto-selects the stored hole, prefills the stored target diameter, and Apply rewrites the SAME node".' },

  // --- UI-82-R3 non-leaf push/pull edit: historical edit input plus a separately live-filtered presentation target.
  'bodyHandlesRef.get::const baseHandle = bodyHandlesRef.current.get(payload.ownerId)':
    { verdict: 'RAW-BY-DESIGN', reason: 'handleEditPushPull needs the committed historical F2 source handle as the edit input even when F2 is superseded and hidden; proven by SolidsWorkbenchPage.pushPull.test.tsx "UI-82-R5: non-leaf edit cancels, rolls back fallible staging, adopts atomically, and preserves the F2 to F3 chain through undo/redo".' },
  'bodyFeatureIds()::const bodyIds = bodyFeatureIds(dag)#handleEditPushPull':
    { verdict: 'RAW-BY-DESIGN', reason: 'handleEditPushPull needs raw ancestry to project the historical F2 lineage; the presentation target is independently live-filtered immediately below, proven by SolidsWorkbenchPage.pushPull.test.tsx "UI-82-R5: non-leaf edit cancels, rolls back fallible staging, adopts atomically, and preserves the F2 to F3 chain through undo/redo".' },
  'bodyHandlesRef.get::const restoreHandle = bodyHandlesRef.current.get(previewFeatureId)':
    { verdict: 'LIVE-FILTERED', reason: 'previewFeatureId can only come from the single non-failed liveBodyFeatureIds lineage match immediately above; proven by SolidsWorkbenchPage.pushPull.test.tsx "UI-82-R5: non-leaf edit cancels, rolls back fallible staging, adopts atomically, and preserves the F2 to F3 chain through undo/redo".' },

  // --- BK-174 defeature edit: SAME projectBodyLineages/liveBodyFeatureIds resolution
  // handleEditPushPull already uses for the identical "direct-edit owner handle was
  // disposed" problem (defeature's own historyRole is 'direct-edit' too, bodyLineage.ts).
  'bodyHandlesRef.get::const reliefOwnerHandle = liveBodyFeatureIds(dag, (id) => bodyHandlesRef.current.has(id)).includes(ownerId) ? bodyHandlesRef.current.get(ownerId) : undefined':
    { verdict: 'LIVE-FILTERED', reason: 'WO-2171 relief face lookup: the handle is read only when ownerId is in liveBodyFeatureIds on the same line, so a consumed body never becomes a relief target. Proven by src/tests/relief/reliefMode.test.tsx "Relief on the rail: pick a flat face, open a picture, Apply, Edit, Undo".' },
  'bodyHandlesRef.get::const reliefTryHandle = bodyHandlesRef.current.get(ownerId)':
    { verdict: 'RAW-BY-DESIGN', reason: 'WO-2171 Apply check builds the relief on the owner the session holds: the owner of a new relief came from the live-filtered face lookup above, and an edited relief must build on its own recorded pre-relief owner, which its own node supersedes (the handleEditPushPull rule); nothing is committed by the check. Proven by src/tests/relief/reliefMode.test.tsx "Relief on the rail: pick a flat face, open a picture, Apply, Edit, Undo".' },

  'bodyFeatureIds()::const bodyIds = bodyFeatureIds(dag)#handleEditDefeature':
    { verdict: 'RAW-BY-DESIGN', reason: 'handleEditDefeature needs raw ancestry to project the edited node\'s own lineage; the recognition target is independently live-filtered immediately below, proven by SolidsWorkbenchPage.defeature.test.tsx "BK-174: tree-menu Edit... re-recognizes the owner body and reopens DefeatureDialog with the stored accept mask, Apply rewrites the same node".' },
  'bodyHandlesRef.get::const body = bodyHandlesRef.current.get(recognizeTargetId)':
    { verdict: 'LIVE-FILTERED', reason: 'recognizeTargetId can only come from the single non-failed liveBodyFeatureIds lineage match immediately above; proven by SolidsWorkbenchPage.defeature.test.tsx "BK-174: tree-menu Edit... re-recognizes the owner body and reopens DefeatureDialog with the stored accept mask, Apply rewrites the same node".' },
  'bodyHandlesRef.get::bodyHandlesRef.current.get(recognizeTargetId) !== body ||':
    { verdict: 'LIVE-FILTERED', reason: 'handleEditDefeature re-checks the exact handle from the single non-failed live projected lineage representative after asynchronous pre-feature recognition; a changed lineage leaf or handle fails the surrounding fingerprint guard instead of becoming a fresh raw pick.' },

  // --- UI-107 Defeature candidate adoption: create-mode owner reads are an atomic
  // transaction snapshot plus a publish-boundary identity check, never a picker.
  // WO-110: the resize-hole preview session's own candidate adoption (added by the
  // keyflow salvage) is now a SECOND, structurally identical site behind each of these
  // two keys -- same `candidate.payload.ownerId` snapshot, same publish-boundary refusal
  // -- so both reasons name both flows rather than blessing only Defeature's copy.
  'bodyHandlesRef.get::const priorOwnerHandle = bodyHandlesRef.current.get(candidate.payload.ownerId)':
    { verdict: 'RAW-BY-DESIGN', reason: 'Defeature and resize-hole create adoption snapshot their preview baseline\'s own owner handle solely for atomic replacement, rollback, and disposal. Proven by SolidsWorkbenchPage.defeature.test.tsx "Cancel after a ready create preview restores the source presentation without authoring history" and SolidsWorkbenchPage.resizeHole.test.tsx "shows live geometry before history mutation, adopts that exact candidate once, stays armed, and round-trips undo/redo".' },
  'bodyHandlesRef.get::if (!editing && (priorOwnerHandle === undefined || bodyHandlesRef.current.get(candidate.payload.ownerId) !== priorOwnerHandle)) {':
    { verdict: 'LIVE-FILTERED', reason: 'Immediately before create-mode publication, Defeature and resize-hole each require the same live baseline lineage-owner handle captured above; an absent handle or changed lineage representative throws out of publish and refuses the transaction, so no stale/raw body can be promoted. The ready-create Cancel and superseded-preview tests in SolidsWorkbenchPage.defeature.test.tsx pin that boundary.' },
  'bodyHandlesRef.get::bodyHandlesRef.current.get(candidate.payload.ownerId) === candidate.recoveryOwnerBody':
    { verdict: 'RAW-BY-DESIGN', reason: 'resize-hole failure recovery compares its own transaction owner with the temporary recovery handle it minted and reinstalled; the identity check only governs cleanup. Proven by SolidsWorkbenchPage.resizeHole.test.tsx "rolls back a non-leaf edit when downstream replay returns a failed status".' },

  // --- WO-054 Hole preview session: same shape and same ruling as the Draft and resize-hole
  // preview siblings below -- the session must materialize the exact owner its intent names,
  // not whatever is currently live. Classified at merge time by the architect (WO-054 was
  // audited before WO-110 made this census green on main, so this row is its only open finding).
  'bodyHandlesRef.get::const sourceHandle = bodyHandlesRef.current.get(ownerId)':
    { verdict: 'RAW-BY-DESIGN', reason: 'createHolePreviewSession must materialize the exact owner recorded in its intent payload, and refuses outright when that handle is absent (returns null before any kernel op); in edit mode it additionally requires the DAG node to still be a hole owned by that same id, so a superseded owner cannot be previewed against. SolidsWorkbenchPage.holePreview.wo042.test.tsx "edit: restores and visibly highlights the saved face reference AND seed point" proves editing against that recorded timeline source.' },

  // --- Draft feature preview: exact historical source materialization and own-node adoption bookkeeping.
  'bodyHandlesRef.get::const sourceHandle = bodyHandlesRef.current.get(firstIntent.payload.ownerId)':
    { verdict: 'RAW-BY-DESIGN', reason: 'Draft edit preview must materialize the exact historical pre-feature owner recorded in its payload. Proven by SolidsWorkbenchPage.draftShellEdit.ui38.test.tsx "previews a non-leaf Draft at its timeline position and replays only downstream after adoption".' },
  'bodyHandlesRef.get::bodyHandlesRef.current.get(captured.snapshot.ownerId) !== stableSourceHandle':
    { verdict: 'RAW-BY-DESIGN', reason: 'Draft preview staleness compares the same recorded historical source handle captured above and never chooses a new pick target. Proven by SolidsWorkbenchPage.draftShellEdit.ui38.test.tsx "previews a non-leaf Draft at its timeline position and replays only downstream after adoption".' },
  'bodyHandlesRef.get::const priorHandle = bodyHandlesRef.current.get(candidate.featureId)':
    { verdict: 'RAW-BY-DESIGN', reason: 'Draft candidate adoption snapshots its own feature node prior handle for atomic replacement, rollback, and disposal bookkeeping. Proven by SolidsWorkbenchPage.draftShellEdit.ui38.test.tsx "previews a non-leaf Draft at its timeline position and replays only downstream after adoption".' },

  // --- WO-241 extrude end-condition target lineage: resolveBodyTargetLineage needs the RAW
  // superset to trace a persisted end-condition body forward through history to its live
  // descendant; the live set is passed alongside it as the SEPARATE second argument that
  // actually governs the resolution (bodyLineage.ts resolveBodyTargetLineage header comment:
  // "a unique live descendant is safe"). Same raw-for-lineage/live-for-resolution split
  // already ruled for refreshBodiesList/syncCamModelBodies above, applied to the extrude
  // end-target resolver instead of a UI list.
  'bodyFeatureIds()::bodyFeatureIds(world.dag),':
    { verdict: 'RAW-BY-DESIGN', reason: 'buildExtrudeRequest\'s resolveBodyTarget callback passes the raw census as resolveBodyTargetLineage\'s ancestry table only; the same call\'s liveBodyFeatureIds(...) argument is what the function actually resolves the live descendant against, so a superseded id can be traced but never silently chosen as the final target. Proven by extrudeTargetLineage.wo241.test.ts "WO-241 persisted extrude targets survive later features" (e.g. "keeps Through all green when a later merge consumes its non-carrier target").' },

  // --- WO-035 Extrude preview session: the boolean TARGET body the dialog already holds,
  // materialized as the pre-feature state, plus the staleness re-check on that same handle.
  // supportBodyIds was later widened past the single target to also cover an explicit or
  // automatic (upToNext/throughAll) end-condition body -- same captured-baseline-vs-current
  // re-check pattern, now over a set instead of one id.
  // The pick surface for a NEW target is elsewhere and live-filtered in both of its forms:
  // the dropdown offers extrudeBodyOptions (liveBodyOptions, plus the edit dialog's own stored
  // target backfilled from the raw superset -- already ruled RAW-BY-DESIGN below), and the
  // viewport target pick resolves through pickAcrossBodies(liveBodyFeatureIds(...)) in
  // handleExtrudeTargetPick. Neither site below widens that surface.
  'bodyHandlesRef.get::const stableTargetHandle = targetFeatureId === null ? undefined : bodyHandlesRef.current.get(targetFeatureId)':
    { verdict: 'RAW-BY-DESIGN', reason: 'the add/remove/intersect preview must restore its pre-feature state from the handle of the target the dialog ALREADY holds -- in create mode always a liveBodyOptions id or a live-filtered viewport pick, in edit mode possibly the feature\'s OWN stored target whose handle is deliberately retained after consumption (the same undo-retention the dress-up edits rely on, stated in this call site\'s own header comment); previewing an edit against its own recorded target is the intent, and the restored body is a serialize/restore CLONE, so the retained handle is never mutated. Proven by SolidsWorkbenchPage.extrudePreview.wo035.test.tsx "create add/remove: the pre-feature state is the TARGET body -- the ghost supersedes it against a scratch-restored handle, Cancel restores it, Apply consumes it".' },
  'bodyHandlesRef.get::if (stableHandle === undefined || delta === undefined || bodyHandlesRef.current.get(id) !== stableHandle) {':
    { verdict: 'RAW-BY-DESIGN', reason: 'materializePreFeature re-reads each recorded supportBodyIds member (target plus any end-condition body) and permits only the exact captured handle -- id ranges only over ids the SAME closure already captured into stableSupportHandles above, so it can narrow what proceeds (refuse on drift) but never choose a new target. Direct generalization of the prior single-target staleness re-check to the now-plural support set. Proven by SolidsWorkbenchPage.extrudePreview.wo035.test.tsx "create add/remove: the pre-feature state is the TARGET body -- the ghost supersedes it against a scratch-restored handle, Cancel restores it, Apply consumes it".' },

  // --- UI-82-R4 candidate transaction: raw live reads are either immutable fingerprint data,
  // explicit boundary cloning, or adoption bookkeeping. Candidate mutations only see cloned/new handles.
  'bodyFeatureIds()::const liveBodyIds = bodyFeatureIds(dag)':
    { verdict: 'RAW-BY-DESIGN', reason: 'transactExistingPushPull snapshots every current cache entry for the full transaction fingerprint; this is read-only rollback bookkeeping. Proven by SolidsWorkbenchPage.pushPull.test.tsx "UI-82-R4: downstream F3 refusal rolls back the entire non-leaf Apply with exact diagnostics and candidate cleanup".' },
  'bodyHandlesRef.get::const liveHandle = bodyHandlesRef.current.get(id)':
    { verdict: 'RAW-BY-DESIGN', reason: 'id is an explicit upstream boundary dependency of the candidate closure; the handle is serialized and restored before use, and only the clone enters candidate mutation. Proven by SolidsWorkbenchPage.pushPull.test.tsx "UI-82-R5: non-leaf edit cancels, rolls back fallible staging, adopts atomically, and preserves the F2 to F3 chain through undo/redo".' },
  'bodyHandlesRef.get::const handle = candidateHandles.get(bodyId) ?? bodyHandlesRef.current.get(bodyId)':
    { verdict: 'LIVE-FILTERED', reason: 'bodyId is drawn from candidateLiveIds immediately above; closure bodies use candidate handles, while unaffected live bodies are read only for staged volume measurement.' },
  'bodyHandlesRef.get::const handle = candidateHandles.get(bodyId) ?? (!closure.has(bodyId) ? bodyHandlesRef.current.get(bodyId) : undefined)':
    { verdict: 'LIVE-FILTERED', reason: 'CAM reference staging explicitly refuses live handles for closure members; only unaffected bodies may use their live handle for the read-only resolve call, and candidateLiveSet gates reachability.' },
  'bodyHandlesRef.get::const priorHandles = new Map(candidatePass.executed.map((id) => [id, bodyHandlesRef.current.get(id)] as const))':
    { verdict: 'RAW-BY-DESIGN', reason: 'post-commit adoption snapshots each executed node\'s own prior handle solely for disposal after the candidate handle is installed. Proven by SolidsWorkbenchPage.pushPull.test.tsx "UI-82-R5: non-leaf edit cancels, rolls back fallible staging, adopts atomically, and preserves the F2 to F3 chain through undo/redo".' },
  'bodyHandlesRef.get::const adopted = bodyHandlesRef.current.get(id)':
    { verdict: 'RAW-BY-DESIGN', reason: 'post-adoption identity compares each executed node\'s own new handle against its prior handle before disposal; it selects no kernel input. Proven by SolidsWorkbenchPage.pushPull.test.tsx "UI-82-R5: non-leaf edit cancels, rolls back fallible staging, adopts atomically, and preserves the F2 to F3 chain through undo/redo".' },
  'bodyFeatureIds()::for (const { bodyId, lineageId } of projectBodyLineages(candidateDag, bodyFeatureIds(candidateDag), candidateLiveIds)) {':
    { verdict: 'LIVE-FILTERED', reason: 'candidate Bodies rows use the raw superset only for lineage projection; projectBodyLineages receives candidateLiveIds as its separately computed live leaf set in the same call.' },
  'bodyFeatureIds()::const stagedCamLive = projectBodyLineages(candidateDag, bodyFeatureIds(candidateDag), candidateLiveIds)':
    { verdict: 'LIVE-FILTERED', reason: 'candidate CAM staging uses the raw superset only for lineage projection; the surfaced geometry set is candidateLiveIds, supplied in the same call.' },
  'bodyFeatureIds()::effectiveExportIds: bodyFeatureIds(dag)':
    { verdict: 'RAW-BY-DESIGN', reason: 'the test-only transaction-state probe mirrors production export eligibility so refusal tests can assert exact pre/post equality; it performs no export or mutation. Proven by SolidsWorkbenchPage.pushPull.test.tsx "UI-82-R4: downstream F3 refusal rolls back the entire non-leaf Apply with exact diagnostics and candidate cleanup".' },

  // --- export: raw enumeration narrowed by persisted hidden state and structural supersession.
  // WO MODEL-WORKSPACE-STL-EXPORT: exportStep and exportStl share the ONE factored
  // resolveExportBodyHandles(featureIds) -- missing handles fail loud with the feature
  // ids (ADR-0003), never silently drop a subset. Its callers (the export click handlers)
  // supply effectiveExportIds, which excludes both persisted-hidden bodies and retained
  // ancestors hidden by structural supersession before any handle is resolved.
  'bodyHandlesRef.get::const bodyHandle = bodyHandlesRef.current.get(id)':
    { verdict: 'LIVE-FILTERED', reason: 'resolveExportBodyHandles receives only effectiveExportIds, which excludes persisted-hidden and structurally superseded bodies before the handle lookup; missing eligible handles fail loud. Proven by SolidsWorkbenchPage.stlExport.test.tsx "exports only the one effectively-visible body (persisted hidden + structural supersession), like STEP" and "missing visible handles refuse rather than silently dropping a body".' },
  'bodyFeatureIds()::const visibleIds = bodyFeatureIds(dag).filter((id) => dag.getNode(id)?.hidden !== true)':
    { verdict: 'LIVE-FILTERED', reason: 'effectiveExportIds starts with the raw census but immediately filters persisted hidden state and then visibleRef structural supersession before either export can resolve a handle. Proven by SolidsWorkbenchPage.bodyHiddenPersist.test.tsx "STEP export honors persisted hidden and structural supersession visibility" and SolidsWorkbenchPage.stlExport.test.tsx "exports only the one effectively-visible body (persisted hidden + structural supersession), like STEP".' },

  // --- test/debug introspection seam.
  'bodyHandlesRef.get::getBodyHandle: (featureId) => bodyHandlesRef.current.get(featureId),':
    { verdict: 'RAW-BY-DESIGN', reason: 'window.__solidsWorkbenchHooks is a test/debug seam that intentionally inspects a consumed body\'s retained handle and is unreachable from production UI. Proven by SolidsWorkbenchPage.camModelRefRelineage.test.tsx "a ModelReference pointing at a LIVE body stays untouched, then degrades the instant that body is CONSUMED by a downstream feature".' },

  // --- toolbar affordance gates: existence-only, actual pick/export candidates are re-derived live downstream.
  'bodyFeatureIds()::const availableBodies = bodyFeatureIds(dag).map((id) => ({ id, label: featureLabel(dag, id) }))':
    { verdict: 'RAW-BY-DESIGN', reason: 'the raw display/affordance superset is paired with liveBodyOptions for every new destructive choice; historical entries are used only to preserve an edit\'s own stored value. Proven by SolidsWorkbenchPage.extrudeBoolean.test.tsx "a consumed target stays visible in its own edit, is excluded from a new picker, and a forced payload naming it refuses BY NAME with no kernel call".' },
  // WO-2089/WO-2090 split this site over two lines; the scan keys on the line carrying availableBodies.
  'availableBodies::(availableBodies.length === 0 && stlBody === null),':
    { verdict: 'RAW-BY-DESIGN', reason: 'gates only the dress-up arm affordance (Fillet, Chamfer, Shell, Draft, Hole); the armed pick resolves liveBodyFeatureIds candidates. An open STL also enables all five, and each STL branch edits the meshEdits journal and reaches no kernel body handle: WO-1936 Fillet (stlFeatureEditsViaModelTools.wo1936.test.tsx "Fillet changes a blend\'s radius: the dialog opens on the measured 3 mm; 5 mm is Setup\'s radius change"), WO-2089 Hole and Chamfer (stlHoleAndChamfer.wo2089.test.tsx "Hole drills a 6 mm through hole where the operator clicks: one journal entry, the part redrawn with it, Undo restores" and "Chamfer cuts a 0.3 mm chamfer on the clicked sharp edge: one journal entry, Undo restores"), WO-2090 Shell and Draft (stlShellAndDraft.wo2090.test.tsx "Shell hollows the plate to a 2 mm wall opening the clicked top face: one journal entry, a closed solid, Undo restores" and "Draft turns the clicked +X side 3 deg about the neutral bottom face: one journal entry, a closed solid, Undo restores"). Proven by SolidsWorkbenchPage.liveBodyPick.test.tsx "Fillet: a post-supersede edge pick lands on F2, never F1" and "face-based New Sketch: a post-supersede face pick consumes F2, never F1".' },
  "availableBodies::disabled: sketchMode.kind !== 'none' || dressUpPickMode.kind !== 'none' || resizeHolePickMode.kind !== 'none' || (availableBodies.length === 0 && stlBody === null),":
    { verdict: 'RAW-BY-DESIGN', reason: 'gates only the Push/Pull button affordance; handlePushPullPick resolves liveBodyFeatureIds candidates. WO-1936: an open STL also enables it, and its STL branch edits the meshEdits journal and reaches no kernel body handle (stlFeatureEditsViaModelTools.wo1936.test.tsx "Push/Pull moves a flat face: drag-or-type entry, Enter previews, Enter applies"). Proven by SolidsWorkbenchPage.liveBodyPick.test.tsx "Push/Pull: a post-supersede face pick creates a pushPull node consuming the live leaf F2, never the stale ancestor F1".' },
  "availableBodies::{ testId: 'workbench-export-step', label: 'Export', icon: cadIcon('export-step'), title: 'Export STEP', disabled: availableBodies.length === 0, onClick: () => void handleExportStepClick() },":
    { verdict: 'RAW-BY-DESIGN', reason: 'gates only the Export STEP button affordance; the click re-derives effectiveExportIds and excludes structural supersession. Proven by SolidsWorkbenchPage.bodyHiddenPersist.test.tsx "STEP export honors persisted hidden and structural supersession visibility".' },
  "availableBodies::{ testId: 'workbench-export-stl', label: 'STL', icon: cadIcon('export-stl'), title: 'Export STL', disabled: availableBodies.length === 0, onClick: () => void handleExportStlClick() },":
    { verdict: 'RAW-BY-DESIGN', reason: 'gates only the Export STL button affordance; the click re-derives effectiveExportIds and excludes structural supersession. Proven by SolidsWorkbenchPage.stlExport.test.tsx "exports only the one effectively-visible body (persisted hidden + structural supersession), like STEP".' },

  // --- handleCanvasClick: raw superset gates which RENDERED mesh is pickable (a
  // superseded body's mesh can still be visible mid-transition), but the hit is
  // then resolved through currentBodyOwnerForRenderedHit(dag, hit.bodyId,
  // currentBodyIds) -- currentBodyIds is the SAME live set (liveBodyFeatureIds)
  // used for the pick-face-armed branch just below it, and that resolver returns
  // the id unchanged only if it is already in currentBodyIds, walks lineage to
  // find a single live descendant otherwise, and returns null on any ambiguous
  // fan-out. selectedBodyId (what actually reaches setSelectedId/
  // selectedFacePickRef) can therefore never be a raw-only superseded id.
  "bodyFeatureIds()::const selectableBodyIds = (sketchMode.kind === 'none' ? bodyFeatureIds(dag) : currentBodyIds)":
    { verdict: 'LIVE-FILTERED', reason: 'feeds pickAcrossBodies only to determine which rendered mesh is hit; the hit.bodyId is immediately resolved through currentBodyOwnerForRenderedHit(dag, hit.bodyId, currentBodyIds) against the live currentBodyIds set, which returns null on ambiguous/no live owner -- a superseded id can never become the resolved selectedBodyId.' },

  // --- Feature-tree body selection: raw authored identity plus separately resolved live presentation.
  'bodyFeatureIds()::const bodyIds = bodyFeatureIds(dag)#SolidsWorkbenchPageDocument':
    { verdict: 'RAW-BY-DESIGN', reason: 'FeatureTree recognizes a clicked historical body-producing feature so selectedId preserves authored edit identity while presentation resolves independently to a live owner. Proven by SolidsWorkbenchPage.treeViewport.ui94.test.tsx "synchronizes leaf, history, fan-out, multi-body, and command-picker paths without collapsing subshape selection".' },

  // --- edit-dialog historical-target display: extrude/boolean edit dialogs must still
  // show their OWN currently-stored target/tool feature even if it has since been
  // superseded; liveBodyOptions (built from currentLiveBodyIds) is the actual pick
  // surface offered for a NEW choice, these two sites only backfill the ALREADY-
  // CHOSEN value so it does not silently vanish from its own dropdown.
  'availableBodies::const existing = availableBodies.find((option) => option.id === currentTarget)':
    { verdict: 'RAW-BY-DESIGN', reason: 'extrudeBodyOptions backfills only the edit dialog\'s own stored target when it is absent from liveBodyOptions; new choices remain live-only. Proven by SolidsWorkbenchPage.extrudeBoolean.test.tsx "a consumed target stays visible in its own edit, is excluded from a new picker, and a forced payload naming it refuses BY NAME with no kernel call".' },
  'availableBodies::const existing = availableBodies.find((option) => option.id === candidate)':
    { verdict: 'RAW-BY-DESIGN', reason: 'booleanBodyOptions backfills only the dialog\'s own stored target/tool when absent from liveBodyOptions and still requires each to precede the edited feature. Proven by SolidsWorkbenchPage.booleanHoleEdit.ui38.test.tsx "edits from tree/toolbar, preserves graph and topology, replays, undoes, and refuses invalid references".' },

  // --- SKETCH-ON-FACE-FIX (workplan 4d): the unified New-sketch pick's ADAPTIVE HINT COPY only asks
  // "does a flat face exist to sketch on" to pick which sentence to show -- it selects no body and
  // arms no operation; the actual face pick still resolves through pickAcrossBodies(liveBodyFeatureIds).
  'availableBodies::const basePlanePickHintMessage = availableBodies.length > 0':
    { verdict: 'RAW-BY-DESIGN', reason: 'basePlanePickHintMessage uses raw existence only to choose display copy; the actual face pick remains live-filtered. Proven by SolidsWorkbenchPage.ui18ConfirmBar.test.tsx "unified New Sketch renders the shared bar, message text, hover readout slot, and Cancel restores the rail" and SolidsWorkbenchPage.sketchPlaneInWorkspace.test.tsx "with all base planes saved hidden, New sketch temporarily reveals all three without changing prefs".' },
}

/** The nearest enclosing name a site sits inside: a `const <name> = ...`
 *  variable declaration (useCallback/useMemo binding or plain const) OR a
 *  `<name>: (...) => {...}` object-property arrow, whichever is closer. Used
 *  ONLY to disambiguate the couple of sites below whose (kind, trimmed-text)
 *  key collides with an unrelated site elsewhere in the file (identical
 *  variable names re-used in two different functions) -- every other site's
 *  key is left as plain (kind, text) so an unrelated edit elsewhere in the
 *  file can never change its identity. */
function nearestEnclosingName(node: ts.Node): string | undefined {
  // Walk up to the nearest FUNCTION-LIKE ancestor first (never the site's own
  // immediately-enclosing `const <x> = <thisCallExpr>` data binding, which
  // would trivially name itself -- e.g. `const bodyIds = bodyFeatureIds(dag)`
  // must resolve to the surrounding useCallback's name, not to `bodyIds`).
  let p: ts.Node | undefined = node.parent
  while (p !== undefined) {
    if (ts.isMethodDeclaration(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) return p.name.text
    if (ts.isFunctionDeclaration(p) && p.name !== undefined) return p.name.text
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      // `owner` is either the direct `const x = () => {}` binding, OR (the
      // common case in this file) a `useCallback(fn, deps)`/`useMemo(fn, deps)`
      // CALL whose OWN parent is the real binding -- e.g. `const
      // refreshBodiesList = useCallback((): void => {...}, [dag, scheduler])`
      // has the arrow's direct parent as the useCallback CallExpression, not
      // the VariableDeclaration.
      let owner: ts.Node | undefined = p.parent
      if (owner !== undefined && ts.isCallExpression(owner)) owner = owner.parent
      if (owner !== undefined && ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) return owner.name.text
      if (owner !== undefined && ts.isPropertyAssignment(owner) && (ts.isIdentifier(owner.name) || ts.isStringLiteralLike(owner.name))) return owner.name.text
      // anonymous (e.g. passed inline as a bare callback arg) -- keep walking up.
    }
    p = p.parent
  }
  return undefined
}

// Two collisions exist where an IDENTICAL trimmed source line (same local
// variable name re-used) appears in two functions needing DIFFERENT
// classifications -- disambiguated by their nearest enclosing name so each
// keeps its own CLASSIFICATIONS entry.
const DISAMBIGUATE_BY_TEXT = new Set<string>([
  'const handle = bodyHandlesRef.current.get(bodyId)',
  'const bodyIds = bodyFeatureIds(dag)',
])

function disambiguate(site: Site, node: ts.Node): string {
  const base = `${site.kind}::${site.text}`
  if (!DISAMBIGUATE_BY_TEXT.has(site.text)) return base
  const owner = nearestEnclosingName(node)
  return owner === undefined ? base : `${base}#${owner}`
}

function classifySites(fileName: string, text: string): Array<Site & { key: string }> {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const lines = text.split(/\r?\n/)
  const out: Array<Site & { key: string }> = []
  const bodyFeatureIdsAliases = collectAliases(sf, 'bodyFeatureIds')
  const availableBodiesAliases = collectAliases(sf, 'availableBodies')
  walk(sf, (node) => {
    let site: Site | null = null
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'current' &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === 'bodyHandlesRef'
    ) {
      site = { kind: 'bodyHandlesRef.get', line: lineOf(node), text: (lines[lineOf(node) - 1] ?? '').trim() }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && bodyFeatureIdsAliases.has(node.expression.text)) {
      site = { kind: 'bodyFeatureIds()', line: lineOf(node), text: (lines[lineOf(node) - 1] ?? '').trim() }
    } else if (ts.isIdentifier(node) && availableBodiesAliases.has(node.text)) {
      const isDecl = ts.isVariableDeclaration(node.parent) && node.parent.name === node
      const isImportBinding = ts.isImportSpecifier(node.parent) || ts.isBindingElement(node.parent)
      if (!isDecl && !isImportBinding) site = { kind: 'availableBodies', line: lineOf(node), text: (lines[lineOf(node) - 1] ?? '').trim() }
    }
    if (site !== null) out.push({ ...site, key: disambiguate(site, node) })
  })
  return out.sort((a, b) => a.line - b.line)
}

describe('SolidsWorkbenchPage raw body-source consumer census (WO UI-51A-R2, CLASS CLOSURE)', () => {
  const raw = readFileSync(SOURCE_PATH, 'utf8')
  const sites = classifySites(SOURCE_PATH, raw)

  it('the scan is non-vacuous: it finds sites of all three kinds', () => {
    expect(sites.length).toBeGreaterThan(20)
    for (const kind of ['bodyHandlesRef.get', 'bodyFeatureIds()', 'availableBodies'] as const) {
      expect(sites.some((s) => s.kind === kind), `no sites found of kind ${kind} -- scanner anchor stale`).toBe(true)
    }
  })

  it('EVERY raw consumer site is classified LIVE-FILTERED or RAW-BY-DESIGN -- an unclassified site fails BY NAME', () => {
    const unclassified = sites.filter((s) => CLASSIFICATIONS[s.key] === undefined)
    expect(
      unclassified,
      `unclassified raw consumer site(s) -- add a CLASSIFICATIONS entry (LIVE-FILTERED with the proving test, or RAW-BY-DESIGN with a one-line legitimacy reason) for each:\n${unclassified
        .map((s) => `  line ${s.line} [${s.kind}]: ${s.text}`)
        .join('\n')}`,
    ).toEqual([])
  })

  it('every classification has a non-empty reason (no bare verdict)', () => {
    for (const [key, c] of Object.entries(CLASSIFICATIONS)) {
      expect(c.reason.trim().length, `empty reason for ${key}`).toBeGreaterThan(10)
      expect(['LIVE-FILTERED', 'RAW-BY-DESIGN']).toContain(c.verdict)
    }
  })

  it('no stale classification entries: every CLASSIFICATIONS key still matches a real site in the file', () => {
    const liveKeys = new Set(sites.map((s) => s.key))
    const stale = Object.keys(CLASSIFICATIONS).filter((k) => !liveKeys.has(k))
    expect(stale, `stale classification(s) no longer present in the source -- remove or fix the key:\n${stale.map((k) => `  ${k}`).join('\n')}`).toEqual([])
  })

  // WO UI-51A-R3 (audit MAJOR 2, disclose-and-pass): the R2 census let a
  // RAW-BY-DESIGN reason merely DISCLOSE a known same-class-unsafe consumer
  // ("DISCLOSED, not proven safe... a CONSUMED-but-retained body currently
  // resolves as if still current") instead of resolving it or citing a test
  // that proves the historical resolve is intentional -- disclosure language
  // is not a legitimacy reason, it is the gate passing with a known leak.
  // This is a MECHANICAL reject: no classification reason may contain
  // "disclosed"/"disclosure" at all, full stop -- a future site cannot re-open
  // this exact escape hatch by copying the old wording.
  //
  // WO UI-51A-R4 (audit MINOR 2): the R3 pattern /\bdisclos(ed|ure)?\b/i only
  // covers the bare stem plus "ed"/"ure" -- it rejects "disclosed" and
  // "disclosure" but PERMITS "disclose", "discloses", and "disclosing" through
  // untouched, so a future RAW-BY-DESIGN reason could reopen the exact same
  // escape hatch just by picking one of those unmatched inflections. Widened
  // to reject the full word family: e(d|s)? | ing | ure.
  const disclosurePattern = /\bdisclos(?:e(?:d|s)?|ing|ure)\b/i

  it('no classification reason contains disclosure language -- disclosing an unsafe consumer is not a legitimacy reason', () => {
    const offenders = Object.entries(CLASSIFICATIONS).filter(([, c]) => disclosurePattern.test(c.reason))
    expect(
      offenders,
      `reason(s) merely DISCLOSE an unresolved risk instead of resolving it (LIVE-FILTERED) or proving it's safe (evidence-backed RAW-BY-DESIGN) -- reword or fix each:\n${offenders
        .map(([k, c]) => `  ${k}: ${c.reason}`)
        .join('\n')}`,
    ).toEqual([])
  })

  // WO UI-51A-R4 (audit MINOR 2, adopted fix): "permanently test at least
  // 'disclosed', 'disclose', 'disclosing', and 'disclosure'" -- a direct unit
  // test on the pattern itself (not merely an incidental pass/fail through
  // CLASSIFICATIONS' current wording), so the full word family stays covered
  // even if every live reason above happens to avoid the word entirely.
  it.each(['disclosed', 'disclose', 'discloses', 'disclosing', 'disclosure'])(
    'disclosure pattern rejects the word form %j (case-insensitive, word-bounded)',
    (word) => {
      expect(disclosurePattern.test(word)).toBe(true)
      expect(disclosurePattern.test(word.toUpperCase())).toBe(true)
      expect(disclosurePattern.test(`a reason that ${word} something`)).toBe(true)
    },
  )

  it('disclosure pattern does not false-positive on an unrelated word sharing the "disclos" stem boundary', () => {
    // "nondisclosure" -- no word boundary before "disclosure" (glued to
    // "non") -- the mechanical reject is scoped to the word itself, not
    // every string that happens to contain it as a substring.
    expect(disclosurePattern.test('nondisclosure')).toBe(false)
  })

  // MUTATION-STYLE PROOF (charter rule 1, "a probe that cannot fail is not a
  // gate"): inject a fixture source string with a genuinely NEW, unclassified
  // raw consumer -- the census must flag it BY NAME, proving the gate is
  // non-vacuous rather than merely "currently passing because nothing new
  // was added since the classification table was written".
  describe('mutation proof: an unclassified raw consumer is caught', () => {
    const fixtureFile = 'fixture-new-leak.tsx'

    it('a new raw bodyHandlesRef.current.get( ) call in a hypothetical new dialog wiring is flagged', () => {
      const fixture = [
        `function BogusExecutor(dag: any, bodyHandlesRef: any, p: any) {`,
        `  const stale = bodyHandlesRef.current.get(p.newPickerTargetId)`,
        `  return stale`,
        `}`,
      ].join('\n')
      const found = classifySites(fixtureFile, fixture)
      expect(found.length, 'fixture anchor did not produce a scannable site').toBe(1)
      expect(CLASSIFICATIONS[found[0].key], 'RED: this synthetic unclassified site must have NO classification entry (that is the point of the proof)').toBeUndefined()
    })

    it('a new raw bodyFeatureIds(dag) call feeding a hypothetical new picker is flagged', () => {
      const fixture = `function NewPickerOptions(dag: any) { return bodyFeatureIds(dag).map((id: string) => ({ id })) }`
      const found = classifySites(fixtureFile, fixture)
      expect(found.length).toBe(1)
      expect(CLASSIFICATIONS[found[0].key]).toBeUndefined()
    })

    it('an ALIASED raw bodyFeatureIds import (evading a literal-token grep) is still caught', () => {
      const fixture = [
        `import { bodyFeatureIds as rawBodies } from './SolidsWorkbenchPage'`,
        `function NewPickerOptions(dag: any) { return rawBodies(dag).map((id: string) => ({ id })) }`,
      ].join('\n')
      const found = classifySites(fixtureFile, fixture)
      expect(found.length, 'alias-resolving scan must still find the call').toBe(1)
      expect(found[0].kind).toBe('bodyFeatureIds()')
      expect(CLASSIFICATIONS[found[0].key]).toBeUndefined()
      // ...and prove a LITERAL-TOKEN scan (the naive approach this AST scan
      // replaces) would have MISSED it, same evasion-proof shape as
      // heal-result-consumer-census.test.ts.
      expect(/\bbodyFeatureIds\s*\(/.test(fixture)).toBe(false)
    })

    it('CONTROL: an already-classified, unchanged site produces zero unclassified findings', () => {
      const found = classifySites(SOURCE_PATH, raw)
      expect(found.filter((s) => CLASSIFICATIONS[s.key] === undefined)).toEqual([])
    })
  })
})
