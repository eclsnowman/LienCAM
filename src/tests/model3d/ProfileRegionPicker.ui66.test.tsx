// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProfileRegion, Vec3 } from '../../geom/geom-service'
import { CommandHistory, FeatureDag } from '../../doc'
import { ExtrudeDialog } from '../../components/model3d/dialogs/ExtrudeDialog'
import { LoftDialog } from '../../components/model3d/dialogs/LoftDialog'
import { RevolveDialog } from '../../components/model3d/dialogs/RevolveDialog'
import { SweepDialog } from '../../components/model3d/dialogs/SweepDialog'
import {
  pickProfileRegion,
  profilePickCandidatesForSketch,
  profilePickKey,
  type ProfilePickRequest,
  type ProfilePickResult,
} from '../../components/model3d/workbench/profileRegionPicker'
import {
  regionProfileSelector,
  resolveProfileSelector,
} from '../../components/model3d/workbench/regionSelector'
import { extractSketchProfile } from '../../components/model3d/workbench/sketchProfile'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'

afterEach(cleanup)

const OPTIONS = [
  { id: 'SK1', label: 'First profile' },
  { id: 'SK2', label: 'Second profile' },
]

function document(): { dag: FeatureDag; history: CommandHistory } {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'First profile' } })
  dag.insertNode({ id: 'SK2', kind: 'sketch', payload: { name: 'Second profile' } })
  return { dag, history: new CommandHistory(dag) }
}

function rectangleProfile(sketchId: string, z: number, withHole = false, xOffset = 0): ProfileRegion {
  const outer: ProfileRegion['loops'][number] = [
    { kind: 'line', a: [xOffset, 0], b: [xOffset + 10, 0], srcId: `${sketchId}.0` },
    { kind: 'line', a: [xOffset + 10, 0], b: [xOffset + 10, 10], srcId: `${sketchId}.1` },
    { kind: 'line', a: [xOffset + 10, 10], b: [xOffset, 10], srcId: `${sketchId}.2` },
    { kind: 'line', a: [xOffset, 10], b: [xOffset, 0], srcId: `${sketchId}.3` },
  ]
  return {
    sketchId,
    plane: {
      origin: { x: 0, y: 0, z },
      normal: { x: 0, y: 0, z: 1 },
      xDir: { x: 1, y: 0, z: 0 },
    },
    loops: withHole
      ? [outer, [{ kind: 'arc', c: [xOffset + 5, 5], r: 2, a0: 0, a1: Math.PI * 2, ccw: true, srcId: `${sketchId}.hole` }]]
      : [outer],
  }
}

function pickedRegion(sketchId: string, signature = [`${sketchId}.region`]): ProfilePickResult {
  return { sketchId, profileSelector: { kind: 'region', signature } }
}

describe('UI-66 shared viewport profile picker', () => {
  it('picks the closest pierced profile region and does not pick through a hole', () => {
    const ray = { origin: { x: 1, y: 1, z: 20 }, direction: { x: 0, y: 0, z: -1 } }
    const back = rectangleProfile('back', 0)
    const front = rectangleProfile('front', 5)
    expect(pickProfileRegion([
      { key: 'back', sketchId: 'back', profileSelector: regionProfileSelector(back), profile: back },
      { key: 'front', sketchId: 'front', profileSelector: regionProfileSelector(front), profile: front },
    ], ray)).toEqual({ sketchId: 'front', profileSelector: regionProfileSelector(front) })

    const holed = rectangleProfile('holed', 0, true)
    expect(pickProfileRegion(
      [{ key: 'holed', sketchId: 'holed', profileSelector: regionProfileSelector(holed), profile: holed }],
      { origin: { x: 5, y: 5, z: 20 }, direction: { x: 0, y: 0, z: -1 } },
    )).toBeNull()
  })

  it('picks a non-first closed region from one master sketch', () => {
    const first = rectangleProfile('SK1.first', 0)
    const second = rectangleProfile('SK1.second', 0, false, 20)
    const candidates = profilePickCandidatesForSketch('SK1', first, [first, second])
    expect(pickProfileRegion(
      candidates,
      { origin: { x: 25, y: 5, z: 20 }, direction: { x: 0, y: 0, z: -1 } },
    )).toEqual({ sketchId: 'SK1', profileSelector: regionProfileSelector(second) })
  })

  it('Extrude, Revolve, and Sweep stay as movable viewport-first palettes while picking', () => {
    let request: ProfilePickRequest | null = null
    const extrude = document()
    const extrudeView = render(
      <ExtrudeDialog
        {...extrude}
        mode="create"
        sketchOptions={OPTIONS}
        onStartProfilePick={(next) => { request = next }}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )

    expect((screen.getByText('Choose profile by name fallback').parentElement as HTMLDetailsElement).open).toBe(false)
    expect(screen.getByTestId('dialog-shell').getAttribute('data-presentation')).toBe('floating-palette')
    expect(screen.getByTestId('dialog-shell-backdrop').classList.contains('modal-backdrop-transparent')).toBe(true)
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect(screen.getByTestId('extrude-pick-profile').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('extrude-profile-pick-guidance').textContent).toMatch(/click regions to toggle/i)
    act(() => { request?.onDone([pickedRegion('SK2')]) })
    expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK2')
    expect(screen.getByTestId('extrude-pick-profile').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('extrude-selected-profile-region').textContent).toMatch(/chosen/i)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(extrude.dag.getNode('F1')?.payload.profileSelector).toEqual(pickedRegion('SK2').profileSelector)

    extrudeView.unmount()
    request = null
    const revolve = document()
    const view = render(
      <RevolveDialog
        {...revolve}
        mode="create"
        sketchOptions={OPTIONS}
        onStartProfilePick={(next) => { request = next }}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )

    expect((screen.getByText('Choose profile by name fallback').parentElement as HTMLDetailsElement).open).toBe(false)
    expect(screen.getByTestId('dialog-shell').getAttribute('data-presentation')).toBe('floating-palette')
    expect(screen.getByTestId('dialog-shell-backdrop').classList.contains('modal-backdrop-transparent')).toBe(true)
    fireEvent.click(screen.getByTestId('revolve-pick-profile'))
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect(screen.getByTestId('revolve-pick-profile').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('revolve-profile-pick-guidance').textContent).toMatch(/click a closed sketch profile/i)
    act(() => { request?.onDone([pickedRegion('SK2')]) })
    expect((screen.getByTestId('revolve-profile-select') as HTMLSelectElement).value).toBe('SK2')
    expect(screen.getByTestId('revolve-pick-profile').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('revolve-selected-profile-region').textContent).toMatch(/chosen/i)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(revolve.dag.getNode('F1')?.payload.profileSelector).toEqual(pickedRegion('SK2').profileSelector)

    view.unmount()
    request = null
    const sweep = document()
    render(
      <SweepDialog
        {...sweep}
        sketchOptions={OPTIONS}
        onStartProfilePick={(next) => { request = next }}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('dialog-shell').getAttribute('data-presentation')).toBe('floating-palette')
    fireEvent.click(screen.getByTestId('sweep-pick-profile'))
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect(screen.getByTestId('sweep-pick-profile').getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('sweep-profile-pick-guidance').textContent).toMatch(/keeps this panel open/i)
    act(() => { request?.onDone([pickedRegion('SK2')]) })
    expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK2')
    expect(screen.getByTestId('sweep-pick-profile').getAttribute('aria-pressed')).toBe('false')
  })

  it.each(['Sweep', 'Loft'] as const)('%s routes every armed cancel surface through the picker stopper before a second Escape closes', (feature) => {
    let request: ProfilePickRequest | null = null
    let stopCalls = 0
    const close = vi.fn()
    const doc = document()
    const startPick = (next: ProfilePickRequest): (() => void) => {
      request = next
      return () => {
        stopCalls++
      }
    }

    render(feature === 'Sweep'
      ? <SweepDialog {...doc} sketchOptions={OPTIONS} onStartProfilePick={startPick} onApplied={() => {}} onClose={close} />
      : <LoftDialog {...doc} sketchOptions={OPTIONS} onStartProfilePick={startPick} onApplied={() => {}} onClose={close} />)

    const pickTestId = feature === 'Sweep' ? 'sweep-pick-profile' : 'loft-pick-profiles'
    const arm = (): void => {
      fireEvent.click(screen.getByTestId(pickTestId))
    }
    const expectArmed = (): void => {
      expect(screen.getByTestId(pickTestId).getAttribute('aria-pressed')).toBe('true')
      expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    }

    arm()
    expectArmed()
    expect(request).not.toBeNull()
    if (feature === 'Sweep') {
      fireEvent.change(screen.getByTestId('sweep-profile-select'), { target: { value: 'SK2' } })
    } else {
      fireEvent.change(screen.getByTestId('loft-section1-select'), { target: { value: 'SK2' } })
      fireEvent.change(screen.getByTestId('loft-section2-select'), { target: { value: 'SK1' } })
    }
    const canceledRequest = request as ProfilePickRequest | null
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect(stopCalls).toBe(1)
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByTestId(pickTestId).getAttribute('aria-pressed')).toBe('false')
    act(() => {
      canceledRequest?.onDone(feature === 'Sweep'
        ? [pickedRegion('SK1')]
        : [pickedRegion('SK1'), pickedRegion('SK2')])
      canceledRequest?.onCancel()
    })

    arm()
    expectArmed()
    fireEvent.click(screen.getByTestId(pickTestId))
    expect(stopCalls).toBe(2)
    expect(close).not.toHaveBeenCalled()

    arm()
    expectArmed()
    fireEvent.click(screen.getByTestId('dialog-shell-close'))
    expect(stopCalls).toBe(3)
    expect(close).not.toHaveBeenCalled()

    arm()
    expectArmed()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(stopCalls).toBe(4)
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)

    if (feature === 'Sweep') {
      expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK2')
    } else {
      expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe('SK2')
      expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe('SK1')
    }
  })

  it.each(['Sweep', 'Loft'] as const)('%s retires one armed picker session exactly once when its palette unmounts', (feature) => {
    let request: ProfilePickRequest | null = null
    let stopCalls = 0
    const doc = document()
    const view = render(feature === 'Sweep'
      ? (
          <SweepDialog
            {...doc}
            sketchOptions={OPTIONS}
            onStartProfilePick={(next) => {
              request = next
              return () => { stopCalls++ }
            }}
            onApplied={() => {}}
            onClose={() => {}}
          />
        )
      : (
          <LoftDialog
            {...doc}
            sketchOptions={OPTIONS}
            onStartProfilePick={(next) => {
              request = next
              return () => { stopCalls++ }
            }}
            onApplied={() => {}}
            onClose={() => {}}
          />
        ))

    fireEvent.click(screen.getByTestId(feature === 'Sweep' ? 'sweep-pick-profile' : 'loft-pick-profiles'))
    expect(request).not.toBeNull()
    view.unmount()
    expect(stopCalls).toBe(1)
    act(() => {
      request?.onCancel()
      request?.onDone(feature === 'Sweep'
        ? [pickedRegion('SK2')]
        : [pickedRegion('SK2'), pickedRegion('SK1')])
    })
    expect(stopCalls).toBe(1)
  })

  it.each(['Sweep', 'Loft'] as const)('%s remains draggable while its viewport picker is armed', (feature) => {
    const doc = document()
    render(feature === 'Sweep'
      ? (
          <SweepDialog
            {...doc}
            sketchOptions={OPTIONS}
            onStartProfilePick={() => () => {}}
            onApplied={() => {}}
            onClose={() => {}}
          />
        )
      : (
          <LoftDialog
            {...doc}
            sketchOptions={OPTIONS}
            onStartProfilePick={() => () => {}}
            onApplied={() => {}}
            onClose={() => {}}
          />
        ))

    fireEvent.click(screen.getByTestId(feature === 'Sweep' ? 'sweep-pick-profile' : 'loft-pick-profiles'))
    const panel = screen.getByTestId('dialog-shell')
    const header = panel.querySelector('.modal-header')
    if (header === null) throw new Error('expected dialog header')
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const getBoundingClientRect = panel.getBoundingClientRect
    panel.getBoundingClientRect = () => ({
      x: 288,
      y: 76,
      width: 320,
      height: 420,
      top: 76,
      right: 608,
      bottom: 496,
      left: 288,
      toJSON: () => ({}),
    }) as DOMRect

    try {
      fireEvent.pointerDown(header, { pointerId: 9, clientX: 312, clientY: 100 })
      fireEvent.pointerMove(window, { pointerId: 9, clientX: 512, clientY: 220 })
      fireEvent.pointerUp(window, { pointerId: 9 })
      expect(panel.style.left).toBe('488px')
      expect(panel.style.top).toBe('196px')
      expect(screen.getByTestId(feature === 'Sweep' ? 'sweep-pick-profile' : 'loft-pick-profiles').getAttribute('aria-pressed')).toBe('true')
    } finally {
      panel.getBoundingClientRect = getBoundingClientRect
      if (innerWidth === undefined) delete (window as { innerWidth?: number }).innerWidth
      else Object.defineProperty(window, 'innerWidth', innerWidth)
      if (innerHeight === undefined) delete (window as { innerHeight?: number }).innerHeight
      else Object.defineProperty(window, 'innerHeight', innerHeight)
    }
  })

  it('Extrude and Revolve both replace the selected profile from create or edit palettes', () => {
    let request: ProfilePickRequest | null = null
    const extrude = document()
    extrude.dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', sketchId: 'SK1', distance: 15, name: 'Extrude F1' } })
    const extrudeView = render(
      <ExtrudeDialog
        {...extrude}
        mode="edit"
        featureId="F1"
        sketchOptions={OPTIONS}
        onStartProfilePick={(next) => { request = next }}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    act(() => { request?.onDone([pickedRegion('SK2')]) })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(extrude.dag.getNode('F1')?.payload.sketchId).toBe('SK2')
    expect(extrude.dag.getNode('F1')?.payload.profileSelector).toEqual(pickedRegion('SK2').profileSelector)
    expect(extrude.dag.getNode('F1')?.consumes).toContain('SK2')
    expect(extrude.dag.getNode('F1')?.consumes).not.toContain('SK1')

    extrudeView.unmount()
    request = null
    const revolve = document()
    revolve.dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'revolve', sketchId: 'SK1', angleDeg: 270, name: 'Revolve F1' } })
    render(
      <RevolveDialog
        {...revolve}
        mode="edit"
        featureId="F1"
        sketchOptions={OPTIONS}
        onStartProfilePick={(next) => { request = next }}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('revolve-pick-profile'))
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    act(() => { request?.onDone([pickedRegion('SK2')]) })
    expect((screen.getByTestId('revolve-profile-select') as HTMLSelectElement).value).toBe('SK2')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(revolve.dag.getNode('F1')?.payload.sketchId).toBe('SK2')
    expect(revolve.dag.getNode('F1')?.payload.profileSelector).toEqual(pickedRegion('SK2').profileSelector)
    expect(revolve.dag.getNode('F1')?.consumes).toContain('SK2')
    expect(revolve.dag.getNode('F1')?.consumes).not.toContain('SK1')
  })

  it('switches an already-selected sketch from a picked region to whole-sketch in both palettes', () => {
    let request: ProfilePickRequest | null = null
    const extrude = document()
    const extrudeView = render(
      <ExtrudeDialog
        {...extrude}
        mode="create"
        sketchOptions={OPTIONS}
        onStartProfilePick={(next) => { request = next }}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    act(() => { request?.onDone([pickedRegion('SK1', ['region-b'])]) })
    expect(screen.getByTestId('extrude-selected-profile-region')).toBeTruthy()
    fireEvent.click(screen.getByTestId('extrude-use-whole-sketch'))
    expect(screen.queryByTestId('extrude-selected-profile-region')).toBeNull()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(extrude.dag.getNode('F1')?.payload.profileSelector).toEqual({ kind: 'whole-sketch' })

    extrudeView.unmount()
    request = null
    const revolve = document()
    render(
      <RevolveDialog
        {...revolve}
        mode="create"
        sketchOptions={OPTIONS}
        onStartProfilePick={(next) => { request = next }}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('revolve-pick-profile'))
    act(() => { request?.onDone([pickedRegion('SK1', ['region-b'])]) })
    expect(screen.getByTestId('revolve-selected-profile-region')).toBeTruthy()
    fireEvent.click(screen.getByTestId('revolve-use-whole-sketch'))
    expect(screen.queryByTestId('revolve-selected-profile-region')).toBeNull()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(revolve.dag.getNode('F1')?.payload.profileSelector).toEqual({ kind: 'whole-sketch' })
  })

  it('keeps missing selectors backward-compatible when legacy Extrude and Revolve features are edited', () => {
    const extrude = document()
    extrude.dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', sketchId: 'SK1', distance: 15, name: 'Extrude F1' } })
    const extrudeView = render(
      <ExtrudeDialog
        {...extrude}
        mode="edit"
        featureId="F1"
        sketchOptions={OPTIONS}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(extrude.dag.getNode('F1')?.payload.profileSelector).toBeUndefined()

    extrudeView.unmount()
    const revolve = document()
    revolve.dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'revolve', sketchId: 'SK1', angleDeg: 270, name: 'Revolve F1' } })
    render(
      <RevolveDialog
        {...revolve}
        mode="edit"
        featureId="F1"
        sketchOptions={OPTIONS}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(revolve.dag.getNode('F1')?.payload.profileSelector).toBeUndefined()
  })

  it('resolves a non-first region by signature across reorder and refuses explicit selector loss', () => {
    const first = rectangleProfile('first', 0)
    const chosen = rectangleProfile('chosen', 0)
    const selector = regionProfileSelector(chosen)

    const reordered = resolveProfileSelector([chosen, first], selector)
    expect(reordered).toEqual({ ok: true, profiles: [chosen] })
    expect(resolveProfileSelector([first], selector)).toMatchObject({
      ok: false,
      code: 'region-not-found',
    })
    expect(resolveProfileSelector([first], undefined)).toEqual({ ok: true, profiles: [first] })
  })

  it('keeps a profile-only legacy sketch viewport-pickable as whole-sketch', () => {
    const legacy = rectangleProfile('SK1', 0)
    const candidates = profilePickCandidatesForSketch('SK1', legacy, undefined)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].profileSelector).toEqual({ kind: 'whole-sketch' })
    expect(pickProfileRegion(
      candidates,
      { origin: { x: 1, y: 1, z: 20 }, direction: { x: 0, y: 0, z: -1 } },
    )).toEqual({ sketchId: 'SK1', profileSelector: { kind: 'whole-sketch' } })
  })

  it('Loft accepts two viewport profiles in click order and keeps name selectors as fallback', () => {
    let request: ProfilePickRequest | null = null
    const loft = document()
    render(
      <LoftDialog
        {...loft}
        sketchOptions={OPTIONS}
        onStartProfilePick={(next) => { request = next }}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )

    expect((screen.getByText('Choose sections by name fallback').parentElement as HTMLDetailsElement).open).toBe(false)
    expect(screen.getByTestId('dialog-shell').getAttribute('data-presentation')).toBe('floating-palette')
    expect(screen.getByTestId('loft-section1-label').textContent).toMatch(/First: First profile/i)
    expect(screen.getByTestId('loft-section2-label').textContent).toMatch(/Second: Second profile/i)
    fireEvent.click(screen.getByTestId('loft-pick-profiles'))
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect(screen.getByTestId('loft-pick-profiles').getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('loft-profile-pick-guidance').textContent).toMatch(/use Done in the viewport/i)
    expect((request as ProfilePickRequest | null)?.maxPicks).toBe(2)
    act(() => { request?.onDone([pickedRegion('SK2'), pickedRegion('SK1')]) })
    expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe('SK2')
    expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe('SK1')
    expect(screen.getByTestId('loft-section1-label').textContent).toMatch(/First: Second profile/i)
    expect(screen.getByTestId('loft-section2-label').textContent).toMatch(/Second: First profile/i)
    expect(screen.getByTestId('loft-pick-profiles').getAttribute('aria-pressed')).toBe('false')
  })
})

// WO BUG-MODEL-REGION-PICK (Operator, 2026-08-05 screenshot). UI-66/UI-92 proved the picker RESOLVES a
// region selector; what was missing was any region to resolve. The sketch accept point refused a
// whole sketch the moment one vertex had degree != 2, so a sketch of overlapping profiles offered
// either its whole first profile or nothing at all -- "Pick a profile to extrude fails ... I want
// enclosed regions. It might be made up of several profiles."
//
// These cases therefore drive the REAL accept point (extractSketchProfile -> the planar arrangement)
// and then the REAL picker over its output, end to end, with no hand-authored ProfileRegion.
describe('BUG-MODEL-REGION-PICK: viewport picking an enclosed sub-region', () => {
  const sketchOf = (entities: SketchEntity[]): Sketch =>
    ({ id: 'S1', layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null })

  const seg = (id: string, ax: number, ay: number, bx: number, by: number): SketchEntity =>
    ({ id, kind: 'line', construction: false, start: { x: ax, y: ay }, end: { x: bx, y: by } })

  const disc = (id: string, cx: number, cy: number, radius: number): SketchEntity =>
    ({ id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius })

  const rect = (prefix: string, x0: number, y0: number, x1: number, y1: number): SketchEntity[] => ([
    seg(`${prefix}0`, x0, y0, x1, y0),
    seg(`${prefix}1`, x1, y0, x1, y1),
    seg(`${prefix}2`, x1, y1, x0, y1),
    seg(`${prefix}3`, x0, y1, x0, y0),
  ])

  /** Straight down the -Z axis at a point of the XY sketch plane, exactly like a top-view click. */
  const rayAt = (x: number, y: number): { origin: Vec3; direction: Vec3 } =>
    ({ origin: { x, y, z: 50 }, direction: { x: 0, y: 0, z: -1 } })

  function loopArea(loop: ProfileRegion['loops'][number]): number {
    const pts = loop.map((s) => (s.kind === 'line'
      ? s.a
      : [s.c[0] + s.r * Math.cos(s.a0), s.c[1] + s.r * Math.sin(s.a0)]))
    let sum = 0
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i]
      const [bx, by] = pts[(i + 1) % pts.length]
      sum += ax * by - bx * ay
    }
    return Math.abs(sum) / 2
  }

  /** Extract for real, then build the picker's candidate list for real. */
  async function pickable(entities: SketchEntity[], sketchId = 'SK1'): Promise<{
    regions: ProfileRegion[]
    candidates: ReturnType<typeof profilePickCandidatesForSketch>
  }> {
    const extracted = await extractSketchProfile(sketchOf(entities), BASE_PLANE_FRAMES.xy, sketchId)
    if (!extracted.ok) throw new Error(`fixture did not extract: ${extracted.refusal.code}`)
    return {
      regions: extracted.regions,
      candidates: profilePickCandidatesForSketch(sketchId, extracted.regions[0], extracted.regions),
    }
  }

  // a = [0,10]x[0,10] crossed by b = [6,16]x[4,14]. No shared endpoint anywhere: before this WO the
  // sketch chained into two whole loops and the 4x6 overlap was not a thing that could be selected.
  const CROSSING = [...rect('a', 0, 0, 10, 10), ...rect('b', 6, 4, 16, 14)]

  it('resolves the overlap region -- boundary edges owned by TWO source profiles -- not the whole profile', async () => {
    const { regions, candidates } = await pickable(CROSSING)
    expect(candidates).toHaveLength(3)

    const hit = pickProfileRegion(candidates, rayAt(8, 7))
    expect(hit).not.toBeNull()
    expect(hit!.sketchId).toBe('SK1')
    expect(hit!.profileSelector.kind).toBe('region')

    // The selector names a region assembled from BOTH rectangles.
    const signature = (hit!.profileSelector as { signature: string[] }).signature
    expect(signature).toEqual(['a1', 'a2', 'b0', 'b3'])

    // ...and resolving it hands the executor exactly that 4x6 region, never regions[0].
    const resolved = resolveProfileSelector(regions, hit!.profileSelector)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(loopArea(resolved.profiles[0].loops[0])).toBeCloseTo(24, 6)
    expect(resolved.profiles[0]).not.toBe(regions[0])
  })

  it('picks a DIFFERENT enclosed region for a click in each sub-area of the same sketch', async () => {
    const { regions, candidates } = await pickable(CROSSING)
    const resolveAt = (x: number, y: number): ProfileRegion => {
      const hit = pickProfileRegion(candidates, rayAt(x, y))
      if (hit === null) throw new Error(`nothing pierced at ${x},${y}`)
      const resolved = resolveProfileSelector(regions, hit.profileSelector)
      if (!resolved.ok) throw new Error(`refused: ${resolved.code}`)
      return resolved.profiles[0]
    }
    // a-only L, the overlap, and b-only L: three clicks, three distinct regions.
    const areas = [resolveAt(2, 2), resolveAt(8, 7), resolveAt(13, 12)].map((r) => loopArea(r.loops[0]))
    expect(areas.map((a) => Math.round(a))).toEqual([76, 24, 76])
    // Non-vacuity: the two 76s really are different regions, not one candidate answering twice.
    const keys = [rayAt(2, 2), rayAt(13, 12)].map((ray) => {
      const hit = pickProfileRegion(candidates, ray)!
      return profilePickKey(hit.sketchId, hit.profileSelector)
    })
    expect(keys[0]).not.toBe(keys[1])
  })

  it('keeps two SAME-signature sibling regions separately pickable and separately resolvable', async () => {
    // A circle biting a square edge leaves two half-disks whose boundary lineage is identically
    // {c, e1}. Both must stay individually selectable, and the key that drives hover/highlight must
    // tell them apart.
    const bitten = [...rect('e', 0, 0, 10, 10), disc('c', 10, 5, 3)]
    const { regions, candidates } = await pickable(bitten, 'SK-BITE')

    const inside = pickProfileRegion(candidates, rayAt(8.5, 5))
    const outside = pickProfileRegion(candidates, rayAt(11.5, 5))
    expect(inside).not.toBeNull()
    expect(outside).not.toBeNull()
    expect(profilePickKey(inside!.sketchId, inside!.profileSelector))
      .not.toBe(profilePickKey(outside!.sketchId, outside!.profileSelector))

    const insideRegion = resolveProfileSelector(regions, inside!.profileSelector)
    const outsideRegion = resolveProfileSelector(regions, outside!.profileSelector)
    expect(insideRegion.ok && outsideRegion.ok).toBe(true)
    if (!insideRegion.ok || !outsideRegion.ok) return
    expect(insideRegion.profiles[0]).not.toBe(outsideRegion.profiles[0])
  })

  it('leaves ORDINARY single-loop and hole behavior exactly as it was', async () => {
    const plain = await pickable(rect('e', 0, 0, 10, 10), 'SK-PLAIN')
    expect(plain.candidates).toHaveLength(1)
    const plainHit = pickProfileRegion(plain.candidates, rayAt(5, 5))
    expect(plainHit).not.toBeNull()
    // One region, so its selector carries no disambiguating ordinal -- byte-identical to what
    // pre-arrangement documents persisted.
    expect(plainHit!.profileSelector).toEqual({ kind: 'region', signature: ['e0', 'e1', 'e2', 'e3'] })
    expect(pickProfileRegion(plain.candidates, rayAt(50, 50))).toBeNull()

    const holed = await pickable([...rect('e', 0, 0, 10, 10), disc('hole', 5, 5, 2)], 'SK-HOLED')
    expect(holed.candidates).toHaveLength(1)
    // Still does NOT pick through the hole, and still picks the material around it.
    expect(pickProfileRegion(holed.candidates, rayAt(5, 5))).toBeNull()
    expect(pickProfileRegion(holed.candidates, rayAt(1, 1))).not.toBeNull()
  })

  it('a stray edge no longer costs the sketch its regions (the reported refusal)', async () => {
    // The exact shape of Operator's status bar: a dangling endpoint (degree 1) beside closed geometry.
    // This threw "vertex ... has degree 1 (expected exactly 2)" and left NOTHING pickable.
    const withSpur = [...CROSSING, seg('spur', 16, 14, 24, 20)]
    const { candidates } = await pickable(withSpur, 'SK-SPUR')
    expect(candidates).toHaveLength(3)
    expect(pickProfileRegion(candidates, rayAt(8, 7))).not.toBeNull()
    // The spur itself encloses nothing and is not offered as anything.
    expect(candidates.flatMap((c) => c.profile.loops.flat()).some((s) => s.srcId === 'spur')).toBe(false)
  })
})
