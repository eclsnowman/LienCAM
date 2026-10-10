// @vitest-environment node
//
// WO INT-15, Work item 2 -- DERIVED COMPLETENESS (binding). The closed domain is EVERY
// window/document key listener registered by code owned by either workspace host. This test
// enumerates that domain from the INT-13C key-listener CENSUS (the SOURCE, not a hand list of the
// five F-cards), classifies every listener's workspace ownership, and asserts each cam-host /
// part-host / sketcher listener is either COVERED by INT-15's suspend-disarm mechanism (or a prior
// workspace-scoping) OR carries a NAMED EXEMPTION with reasoning. FAIL-CLOSED: a census listener
// with no ruling turns this RED (a future key listener cannot bypass the routing contract
// silently), and a ruling for a listener no longer in the census turns it RED too (no stale
// blessings). The behavioural proof that F-1..F-5 actually disarm lives in the interleave tests;
// this is the STRUCTURAL completeness gate over the whole domain.
//
// WHY THE CENSUS IS THE SOURCE. The census (key-listener-census.mjs) DERIVES its 22 listeners from
// the tree and, run as its own gate, refuses any NEW tree listener until census.json records it --
// so census.json is the authored, complete set. Reading it here and ruling every entry chains the
// two gates: a new tree listener -> census gate RED -> census.json gains it -> THIS test RED until
// it carries a ruling. census.json is an INT-13C artifact (read-only to this WO); this test never
// writes it.
//
// WO INT-18 (F-6 residual): SolidsWorkbenchPage.tsx#2 (the bare-N new-sketch/look-normal-to arm
// listener) was the ONE census entry INT-15 could only rule 'exempt:F-6-residual-part-host-leak'
// -- a disclosed, out-of-manifest gap, not a proof of coverage. INT-18 workspace-scoped that
// listener (gated on `suspended`, the same INT-15/F-2 detach-on-suspend idiom) and this file's
// ruling for that row now reads 'INT-18/F-6', a real MECHANISM the non-vacuity test below proves
// used -- the census PROVES the gate, per the WO's own binding language, rather than exempting it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CENSUS_JSON = resolve(HERE, '../../../test_fixtures/evidence/INT-13C/census/census.json')

type WsClass = 'cam-host' | 'part-host' | 'sketcher-both' | 'workspace-neutral'
interface Ruling {
  cls: WsClass
  /** A disarm-mechanism tag (covered) OR an 'exempt:<slug>' (named exemption). */
  coverage: string
  note: string
}

// The recognized disarm mechanisms (COVERED). Anything else must be an 'exempt:*' named exemption.
const MECHANISMS = new Set([
  'INT-15/F-1', 'INT-15/F-2', 'INT-15/F-3', 'INT-15/F-4', 'INT-15/F-5',
  'INT-13C/D5.4-history', 'INT-13C/P2-workspace-guard', 'INT-13B/part-host-suspend',
  'INT-18/F-6',
])

// Per-listener RULINGS, keyed by the census identity `${file}#${ordinal}` (the census keys on
// (file, ordinal), NOT line -- line is recorded-not-asserted, P1-DRIFT). STATE_CENSUS style: every
// row states class + coverage/exemption + a one-line reasoning note.
const RULINGS: Record<string, Ruling> = {
  // --- CAM-host modals (root-level, CAM-scoped). Disarmed by F-4: a workspace switch nulls the
  //     store's `activeModal`, unmounting the modal and detaching its window listener. Most also
  //     self-gate on a transient sub-mode; F-4 is the workspace-level backstop. --------------------
  'src/components/modals/SketchEntryModal.tsx#0': { cls: 'cam-host', coverage: 'INT-15/F-4',
    note: 'Whole-modal Escape -> closeModal; the F-4 specimen. activeModal nulled on switch unmounts it.' },
  'src/components/modals/NewOperationModal.tsx#0': { cls: 'cam-host', coverage: 'INT-15/F-4',
    note: 'Sub-state Escape (hole-review, gated on reviewingHoleLoopId); F-4 unmounts the modal on switch.' },
  'src/components/modals/PostProcessModal.tsx#0': { cls: 'cam-host', coverage: 'INT-15/F-4',
    note: 'Flyout Escape (gated on flyout-open); openable from TopToolbar in either ws, F-4 closes it on switch.' },
  'src/components/modals/SetupModal.tsx#0': { cls: 'cam-host', coverage: 'INT-15/F-4',
    note: 'Sub-state Escape (vertex-pick, gated on isPickingVertex); F-4 unmounts the modal on switch.' },

  // --- CAM-host component window listeners (the F-1/F-2/F-3 fixes) --------------------------------
  'src/components/panels/DesignTree.tsx#0': { cls: 'cam-host', coverage: 'INT-15/F-1',
    note: 'Bare-F2 rename; self-gates on workspace===cam (no suspend prop reaches this panel).' },
  'src/components/viewport/Viewport.tsx#0': { cls: 'cam-host', coverage: 'INT-15/F-2',
    note: 'Escape face-select cancel; effect gated on the suspended prop (App.tsx workspace signal).' },
  'src/lib/viewport/CNCViewport.ts#1': { cls: 'cam-host', coverage: 'INT-15/F-3',
    note: 'Slice-plane Z-edit Enter/Escape; suspendRender detaches+nulls it (close-on-suspend).' },

  // --- CAM-host listeners already workspace-scoped before INT-15 ---------------------------------
  'src/components/toolbar/TopToolbar.tsx#0': { cls: 'cam-host', coverage: 'INT-13C/D5.4-history',
    note: 'Ctrl+Z/Y history; D5.4 resolves to the ACTIVE workspace history, never the suspended one.' },
  'src/hooks/useGlobalShortcuts.ts#0': { cls: 'cam-host', coverage: 'INT-13C/P2-workspace-guard',
    note: 'G/N/Delete CAM globals; shortcutsAllowed() early-returns unless workspace===cam.' },
  'src/lib/viewport/CNCViewport.ts#0': { cls: 'cam-host', coverage: 'exempt:text-input-native',
    note: 'Slice-plane Z FIELD arrow/Enter/Escape on the input; display:none blurs the field, so it cannot fire while suspended, and it stopPropagation-s within the field.' },

  // --- The shared sketcher package (both hosts mount it): F-5 ------------------------------------
  'src/lib/sketch/sketcher/sketchInteraction.ts#0': { cls: 'sketcher-both', coverage: 'INT-15/F-5',
    note: 'Single-key tool chords; Sketcher.suspend() detaches the handler, resume() re-arms -- both mounts.' },

  // --- Part-host listeners: OUTSIDE INT-15 fix manifest (SolidsWorkbenchPage/model3d not owned).
  //     Named exemption: INT-15 scopes CAM-host + sketcher; the Part host is governed by INT-13B's
  //     onWorkspaceSuspend (disarmActiveTool + setDialog(none) + suspended-gated capture owner).
  //     The bare-N (#2) was the ONE residual not suspend-scoped (disclosed as follow-up F-6) --
  //     INT-18 closed that gap directly on the listener's own registration effect. --------------------
  'src/components/model3d/SolidsWorkbenchPage.tsx#0': { cls: 'part-host', coverage: 'exempt:out-of-manifest-part-host',
    note: 'resize-hole Escape, gated on resizeHolePickMode; INT-13B disarmActiveTool clears the sub-mode on suspend.' },
  'src/components/model3d/SolidsWorkbenchPage.tsx#1': { cls: 'part-host', coverage: 'exempt:out-of-manifest-part-host',
    note: 'base-plane-pick Escape, gated on sketchMode===pick-base-plane; INT-13B suspend clears the sub-mode.' },
  'src/components/model3d/SolidsWorkbenchPage.tsx#2': { cls: 'part-host', coverage: 'INT-18/F-6',
    note: 'Bare-N new-sketch/look-normal-to arm; WO INT-18 gated the registration effect on `suspended` (detach-on-suspend, the INT-15/F-2 idiom) -- the prior symmetric part-host leak is now COVERED, not exempted.' },
  'src/components/model3d/SolidsWorkbenchPage.tsx#3': { cls: 'part-host', coverage: 'exempt:out-of-manifest-part-host',
    note: 'nPick Escape, gated on nPickArmed; downstream of #2, cleared with the tool state on suspend.' },
  'src/components/model3d/SolidsWorkbenchPage.tsx#4': { cls: 'part-host', coverage: 'exempt:out-of-manifest-part-host',
    note: 'push-pull Escape, gated on pushPullMode; INT-13B disarmActiveTool clears the sub-mode on suspend.' },
  'src/components/model3d/SolidsWorkbenchPage.tsx#5': { cls: 'part-host', coverage: 'INT-13B/part-host-suspend',
    note: 'Capture keyboard-ownership owner; its registration effect is gated on `suspended` (removed while suspended).' },
  'src/components/model3d/dialogs/DialogShell.tsx#0': { cls: 'part-host', coverage: 'INT-13B/part-host-suspend',
    note: 'Workbench dialog Escape; INT-13B suspend step 2 setDialog({kind:none}) unmounts the dialog.' },
  'src/components/panels/TreeContextMenu.tsx#0': { cls: 'part-host', coverage: 'exempt:modal-transient',
    note: 'model3d tree context-menu Escape; mounted ONLY while the menu is open (transient), gone at rest.' },

  // --- Workspace-neutral: not owned by either app-shell host --------------------------------------
  'src/components/sketch3dlab/Sketch3dLabPage.tsx#0': { cls: 'workspace-neutral', coverage: 'exempt:standalone-lab-route',
    note: 'The ?lab3d standalone lab page, never mounted in the CAM/Part app shell; no workspace axis applies.' },
  'src/lib/sketch/sketcher/overlays/SketchContextMenu.tsx#0': { cls: 'workspace-neutral', coverage: 'exempt:modal-transient',
    note: 'Sketch overlay context-menu Escape; mounted only while the menu is open, gone at rest.' },
  'src/lib/sketch/sketcher/overlays/SketchDrawValueInput.tsx#0': { cls: 'workspace-neutral', coverage: 'exempt:text-input-native',
    note: 'Numeric mid-draw entry field; only reacts while the field itself is focused (display:none blurs it).' },
}

interface CensusListener { file: string; ordinal: number; line: number; disposition: string; phase: string }
const census = JSON.parse(readFileSync(CENSUS_JSON, 'utf8')) as { listeners: CensusListener[] }
const key = (l: { file: string; ordinal: number }): string => `${l.file}#${l.ordinal}`
const isCovered = (c: string): boolean => MECHANISMS.has(c)
const isExempt = (c: string): boolean => c.startsWith('exempt:')

describe('INT-15 derived completeness: every census key listener carries a workspace-ownership ruling', () => {
  it('the census is non-trivial (guards against an empty/renamed census silently passing)', () => {
    expect(census.listeners.length).toBeGreaterThanOrEqual(22)
  })

  it('EVERY census listener has a ruling (a new/unruled listener fails RED -- fail closed)', () => {
    const unruled = census.listeners.filter((l) => !RULINGS[key(l)]).map((l) => `${l.file}:${l.line} (#${l.ordinal})`)
    expect(unruled, `unruled census listeners (add a workspace ruling): ${unruled.join(', ')}`).toEqual([])
  })

  it('no ruling refers to a listener absent from the census (no stale blessings)', () => {
    const censusKeys = new Set(census.listeners.map(key))
    const stale = Object.keys(RULINGS).filter((k) => !censusKeys.has(k))
    expect(stale, `stale rulings (listener gone from census): ${stale.join(', ')}`).toEqual([])
  })

  it('every CAM-host / PART-host / SKETCHER listener is COVERED by a disarm mechanism or a NAMED EXEMPTION', () => {
    const offenders: string[] = []
    for (const l of census.listeners) {
      const r = RULINGS[key(l)]
      if (!r) continue // caught by the fail-closed test above
      if (r.cls === 'workspace-neutral') continue // neutral needs only a note (has one)
      if (!isCovered(r.coverage) && !isExempt(r.coverage)) {
        offenders.push(`${l.file}:${l.line} (#${l.ordinal}) [${r.cls}] coverage="${r.coverage}" is neither a mechanism nor an exempt:* exemption`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('all five INT-15 mechanisms (F-1..F-5) plus INT-18/F-6 each cover at least one listener (non-vacuity)', () => {
    const used = new Set(Object.values(RULINGS).map((r) => r.coverage))
    for (const f of ['INT-15/F-1', 'INT-15/F-2', 'INT-15/F-3', 'INT-15/F-4', 'INT-15/F-5', 'INT-18/F-6']) {
      expect(used.has(f), `no census listener is ruled as covered by ${f}`).toBe(true)
    }
  })

  it('the F-6 residual no longer carries the old exempt:F-6-residual-part-host-leak ruling (proven, not exempted)', () => {
    const stale = Object.values(RULINGS).filter((r) => r.coverage === 'exempt:F-6-residual-part-host-leak')
    expect(stale, 'the F-6 exemption must be replaced by a real covered ruling, not merely relabeled').toEqual([])
  })

  it('prints the STATE_CENSUS ownership table (evidence aid)', () => {
    const rows = census.listeners.map((l) => {
      const r = RULINGS[key(l)]
      return `${(r?.cls ?? '???').padEnd(17)} ${(r?.coverage ?? '???').padEnd(34)} ${l.file}:${l.line} -- ${r?.note ?? ''}`
    })
    // eslint-disable-next-line no-console
    console.log('\nINT-15 window key-listener ownership census:\n' + rows.join('\n'))
    expect(rows.length).toBe(census.listeners.length)
  })
})
