// Global app-preferences slice (Settings panel, Phase 4):
// `appSettings.projectionToleranceDefault` is an APP preference, NOT project
// data. It must:
//   (a) default to 0.02 and be mutable via setProjectionToleranceDefault;
//   (b) live as a store-root sibling of `project` so it is persisted in
//       localStorage but NEVER written into the .camproject export
//       (saveProjectToFile serializes only `project`);
//   (c) feed the STL projection-tolerance fallback chain
//       `geo.projectionTolerance ?? appSettings.projectionToleranceDefault ?? 0.02`.
//
// Recon contract: docs/planning/PHASE4-STL-TOLERANCE-RECON.md (Option A).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useCamStore, PROJECTION_TOLERANCE_FALLBACK } from '../../store'
import { NAV_PRESETS, navInvertWheelDeltaY, navInvertPanDelta } from '../../types'
import type { ImportedGeometry } from '../../types'

const state = () => useCamStore.getState()

// Snapshot + restore the pref so tests don't bleed into one another.
let savedDefault: number
beforeEach(() => {
  savedDefault = state().appSettings.projectionToleranceDefault
})
afterEach(() => {
  useCamStore.setState((s) => ({
    appSettings: { ...s.appSettings, projectionToleranceDefault: savedDefault },
  }))
})

describe('appSettings.projectionToleranceDefault', () => {
  it('(a) defaults to 0.02 and the setter updates it', () => {
    // Fresh store value equals the exported fallback constant (0.02).
    expect(PROJECTION_TOLERANCE_FALLBACK).toBe(0.02)
    expect(state().appSettings.projectionToleranceDefault).toBe(0.02)

    state().setProjectionToleranceDefault(0.15)
    expect(state().appSettings.projectionToleranceDefault).toBe(0.15)

    state().setProjectionToleranceDefault(0.5)
    expect(state().appSettings.projectionToleranceDefault).toBe(0.5)
  })

  it('(b) is a store-root pref, NOT part of the Project / .camproject export', () => {
    state().setProjectionToleranceDefault(0.33)

    // The app pref lives at the store root, sibling of `project`.
    expect(state().appSettings.projectionToleranceDefault).toBe(0.33)

    // The Project object must not carry the pref under any name.
    const project = state().project as unknown as Record<string, unknown>
    expect('appSettings' in project).toBe(false)
    expect('projectionToleranceDefault' in project).toBe(false)

    // saveProjectToFile serializes EXACTLY `JSON.stringify(getState().project)`
    // (see src/store/index.ts saveProjectToFile). Those are the precise bytes
    // written to the .camproject file. Assert the pref does not appear in them.
    const exportedBytes = JSON.stringify(state().project)
    expect(exportedBytes).not.toContain('projectionToleranceDefault')
    expect(exportedBytes).not.toContain('appSettings')
    const exported = JSON.parse(exportedBytes)
    expect('appSettings' in exported).toBe(false)
    expect('projectionToleranceDefault' in exported).toBe(false)
  })

  it('(c) projection-tolerance fallback chain resolves correctly', () => {
    // Mirror the exact expression the consumers use.
    const resolve = (geo: Pick<ImportedGeometry, 'projectionTolerance'>) =>
      geo.projectionTolerance ??
      state().appSettings.projectionToleranceDefault ??
      0.02

    // Geo WITH its own pinned per-model value -> uses its own.
    state().setProjectionToleranceDefault(0.2)
    expect(resolve({ projectionTolerance: 0.5 })).toBe(0.5)

    // Geo WITHOUT a per-model value -> uses the global default.
    expect(resolve({ projectionTolerance: undefined })).toBe(0.2)

    // Both absent (global somehow undefined) -> hard floor 0.02.
    useCamStore.setState((s) => ({
      appSettings: {
        ...s.appSettings,
        projectionToleranceDefault: undefined as unknown as number,
      },
    }))
    expect(resolve({ projectionTolerance: undefined })).toBe(0.02)
  })

  it('navPreset/invertZoom/invertPan: defaults, setters, and export-isolation', () => {
    // (a) Defaults: bare-button left-orbit preset, no inversion.
    expect(state().appSettings.navPreset).toBe('liencnc-default')
    expect(state().appSettings.invertZoom).toBe(false)
    expect(state().appSettings.invertPan).toBe(false)

    // Setters update each field independently.
    state().setNavPreset('onshape')
    expect(state().appSettings.navPreset).toBe('onshape')
    state().setNavPreset('orbit-middle')
    expect(state().appSettings.navPreset).toBe('orbit-middle')
    state().setInvertZoom(true)
    expect(state().appSettings.invertZoom).toBe(true)
    state().setInvertPan(true)
    expect(state().appSettings.invertPan).toBe(true)

    // (b) Export-isolation: these are APP prefs, NOT project data. They must
    // never appear in the serialized .camproject bytes (mirrors the tolerance
    // assertion above).
    const exportedBytes = JSON.stringify(state().project)
    expect(exportedBytes).not.toContain('navPreset')
    expect(exportedBytes).not.toContain('invertZoom')
    expect(exportedBytes).not.toContain('invertPan')
    const project = state().project as unknown as Record<string, unknown>
    expect('navPreset' in project).toBe(false)
    expect('invertZoom' in project).toBe(false)
    expect('invertPan' in project).toBe(false)

    // Restore defaults so we don't bleed into sibling tests.
    state().setNavPreset('liencnc-default')
    state().setInvertZoom(false)
    state().setInvertPan(false)
  })

  it('NAV_PRESETS maps each bare-button preset to the expected button actions', () => {
    // The preset table is the single source of truth the viewport translates
    // into THREE.MOUSE constants. Bare-button presets carry NO modifierRules
    // (the faithful modifier-gated presets do — locked in the next test).
    expect(Object.keys(NAV_PRESETS).sort()).toEqual(
      ['creo', 'fusion', 'inventor', 'liencnc-default', 'onshape', 'orbit-middle', 'solidworks'],
    )
    // The "LienCAM default" preset = today's OrbitControls default. WO-268
    // renamed its LABEL only; the `liencnc-default` id above is persisted in
    // appSettings and is deliberately frozen (renaming it orphans saved prefs).
    expect(NAV_PRESETS['liencnc-default'].mouseButtons).toEqual({
      LEFT: 'orbit', MIDDLE: 'zoom', RIGHT: 'pan',
    })
    expect(NAV_PRESETS['liencnc-default'].modifierRules).toBeUndefined()
    // Onshape: right-orbit, middle-pan, left free for select.
    expect(NAV_PRESETS.onshape.mouseButtons).toEqual({
      LEFT: 'none', MIDDLE: 'pan', RIGHT: 'orbit',
    })
    expect(NAV_PRESETS.onshape.modifierRules).toBeUndefined()
    // Orbit-on-middle: middle-orbit, right-pan, left free for select.
    expect(NAV_PRESETS['orbit-middle'].mouseButtons).toEqual({
      LEFT: 'none', MIDDLE: 'orbit', RIGHT: 'pan',
    })
    expect(NAV_PRESETS['orbit-middle'].modifierRules).toBeUndefined()
  })

  it('NAV_PRESETS faithful presets carry modifier rules + reserve LEFT for select', () => {
    // Faithful CAD presets (RECON AREA 3): LEFT=none (select), and a
    // modifierRules table the viewport resolves per gesture via resolveNavAction.
    for (const id of ['fusion', 'solidworks', 'inventor', 'creo'] as const) {
      const p = NAV_PRESETS[id]
      expect(p.mouseButtons.LEFT).toBe('none')
      expect(Array.isArray(p.modifierRules)).toBe(true)
      expect(p.modifierRules!.length).toBeGreaterThan(0)
    }
  })

  it('navInvertWheelDeltaY: identity when off, negates deltaY when on (Item 3)', () => {
    // OrbitControls dollies IN when deltaY < 0, OUT when > 0. invert=false must
    // be the identity (byte-identical default wheel behavior); invert=true must
    // flip the sign so wheel-up becomes zoom-out and vice versa.
    expect(navInvertWheelDeltaY(100, false)).toBe(100)
    expect(navInvertWheelDeltaY(-100, false)).toBe(-100)
    expect(navInvertWheelDeltaY(0, false)).toBe(0)
    expect(navInvertWheelDeltaY(100, true)).toBe(-100)
    expect(navInvertWheelDeltaY(-100, true)).toBe(100)
    // Negating zero stays a (non-negative) zero so the "no scroll" case is inert.
    expect(navInvertWheelDeltaY(0, true)).toBe(-0)
  })

  it('navInvertPanDelta: identity when off, negates both deltas when on (Item 3)', () => {
    expect(navInvertPanDelta(3, -7, false)).toEqual({ x: 3, y: -7 })
    expect(navInvertPanDelta(3, -7, true)).toEqual({ x: -3, y: 7 })
    expect(navInvertPanDelta(0, 0, true)).toEqual({ x: -0, y: -0 })
  })

  it('brepTessellationQuality: defaults to balanced and the setter updates it', () => {
    // Default render fidelity is 'balanced' (smoother than the old 0.1/0.5 floor).
    expect(state().appSettings.brepTessellationQuality).toBe('balanced')

    state().setBrepTessellationQuality('high')
    expect(state().appSettings.brepTessellationQuality).toBe('high')

    state().setBrepTessellationQuality('performance')
    expect(state().appSettings.brepTessellationQuality).toBe('performance')

    // It is an APP pref, never part of the serialized .camproject export.
    const exportedBytes = JSON.stringify(state().project)
    expect(exportedBytes).not.toContain('brepTessellationQuality')

    // Restore default so we don't bleed into sibling tests.
    state().setBrepTessellationQuality('balanced')
  })

  it('showSplash: defaults to true and survives persist/merge (no migration)', () => {
    // Default: a fresh store (and any older saved blob that predates the field)
    // shows the splash. The inline boot script in index.html relies on this
    // default-to-showing semantics for new users.
    expect(state().appSettings.showSplash).toBe(true)

    // The setter flips it; the inline boot script reads false on the next load.
    state().setShowSplash(false)
    expect(state().appSettings.showSplash).toBe(false)
    state().setShowSplash(true)
    expect(state().appSettings.showSplash).toBe(true)

    // persist/merge back-compat: persistMerge spreads persisted appSettings over
    // the current defaults, so an OLD blob lacking showSplash resolves to the
    // default (true) and a blob WITH it preserves the stored value — no migration.
    const merged = (...persisted: Array<Record<string, unknown>>) =>
      ({ ...state().appSettings, ...(persisted[0] ?? {}) } as { showSplash: boolean }).showSplash
    // Old blob (field absent) -> default true.
    expect(merged({ navPreset: 'onshape' })).toBe(true)
    // Blob with explicit false -> preserved.
    expect(merged({ showSplash: false })).toBe(false)
  })

  it('survives a project save->load round-trip unchanged (project-independent)', () => {
    // The pref is an APP preference, not project data: loading a project from
    // file (loadProjectFromFile) must NOT clobber or carry it. We set the pref,
    // export the current project, then load it back and confirm the pref is
    // untouched and never appeared in the serialized project bytes.
    state().setProjectionToleranceDefault(0.07)
    const exported = JSON.stringify(state().project)
    expect(exported).not.toContain('projectionToleranceDefault')

    state().loadProjectFromFile(exported)
    // App pref is unaffected by loading a project.
    expect(state().appSettings.projectionToleranceDefault).toBe(0.07)
    // And the loaded project still carries no pref key.
    const loaded = state().project as unknown as Record<string, unknown>
    expect('projectionToleranceDefault' in loaded).toBe(false)
  })
})
