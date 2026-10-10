// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import * as cageModule from '../../form/cage'
import { type Cage, edgeKey } from '../../form/cage'
import { FormOverlay } from '../../form/formOverlay'
import { useFormStore } from '../../form/formStore'
import { boxCage, planeCage } from '../../form/starters'
import { extrudeProfileCage } from '../../form/profile'

const st = () => useFormStore.getState()
let overlay: FormOverlay
let unsubscribe: () => void
const lines = (name = 'form-open-borders') => overlay.root.getObjectByName(name) as THREE.LineSegments
// Independent oracle: retain edge identities even when Unweld's two sides coincide.
function borderKeys(cage: Cage): string[] {
  const faces = new Map<string, Set<number>>()
  cage.faces.forEach((loop, f) => loop.forEach((a, i) => {
    const key = edgeKey(a, loop[(i + 1) % loop.length])
    if (!faces.has(key)) faces.set(key, new Set())
    faces.get(key)!.add(f)
  }))
  return [...faces].filter(([, uses]) => uses.size === 1).map(([key]) => key)
}
const segments = (cage: Cage, keys: string[]) => keys.map((key) => key.split(':').map(Number).flatMap((i) => cage.positions[i]).map(Math.fround).join(',')).sort()
function assertBorders(count: number) {
  const cage = st().cage
  const keys = borderKeys(cage)
  expect(keys).toHaveLength(count)
  const p = lines()?.geometry.getAttribute('position')
  const actual = p ? Array.from({ length: p.count / 2 }, (_, i) => Array.from((p.array as Float32Array).slice(i * 6, i * 6 + 6)).join(',')).sort() : []
  expect(actual).toEqual(segments(cage, keys))
}
const select = (edges: string[] = [], faces: number[] = []) => st().setSelection({ points: [], edges, faces })
const open = (cage: Cage) => st().openSession({ featureId: null, name: 'Borders', cage })

beforeEach(() => {
  open(boxCage({ segments: { x: 2, y: 2, z: 2 } }))
  overlay = new FormOverlay({ canvas: document.createElement('canvas'), camera: () => new THREE.PerspectiveCamera(), addObject: () => {}, removeObject: () => {}, requestRender: () => {} })
  const push = () => {
    const s = st()
    overlay.update({ cage: s.cage, topologyVersion: s.topologyVersion, displayMode: s.displayMode, dragging: s.dragging, skinLevel: 1 })
    overlay.setHighlight(s.cage, s.selection, null)
  }
  unsubscribe = useFormStore.subscribe(push)
  push()
})
afterEach(() => { unsubscribe(); overlay.dispose(); vi.restoreAllMocks() })

describe('WO-2498 live cage borders', () => {
  it('12-point extrude cage moves without recounting edges or reallocating line attributes', () => {
    const { cage } = extrudeProfileCage({ closed: true, points: [[-20, -20, 0], [20, -20, 0], [20, 20, 0], [-20, 20, 0]] }, { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }, 20)
    // WO-2500 keeps rectangle corners and uses three rings for the light cage.
    expect(cage.positions).toHaveLength(12)
    unsubscribe()
    const state = { cage, topologyVersion: 100000, displayMode: 'both' as const, dragging: false }
    overlay.update(state)
    const plain = lines('form-cage-edges').geometry.getAttribute('position')
    const spy = vi.spyOn(cageModule, 'cageEdgeFaceCounts')
    const times: number[] = []
    for (let i = 0; i < 50; i++) {
      const moved: Cage = { ...cage, positions: cage.positions.map(([x, y, z]) => [x + i * 0.01, y, z]) }
      const start = performance.now()
      overlay.update({ ...state, cage: moved })
      if (i >= 10) times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    console.info(JSON.stringify({ benchmark: '12-point extrude, automatic rest level, 10 warmup + 40 moves', skinLevel: overlay.shownLevel, faces: cage.faces.length, medianMs: times[20], p95Ms: times[38] }))
    expect(spy).not.toHaveBeenCalled()
    // Main recreates this attribute; only the new overlay promises to reuse it.
    if (lines()) expect(lines('form-cage-edges').geometry.getAttribute('position')).toBe(plain)
    unsubscribe = () => {}
  })

  it('closed box, Delete, undo/redo and Fill hole keep exact one-face segments', () => {
    assertBorders(0)
    select([], [0]); st().deleteSelection(); assertBorders(4)
    st().undo(); assertBorders(0)
    st().redo(); assertBorders(4)
    select([borderKeys(st().cage)[0]]); st().fillHoleAtSelection(); assertBorders(0)
    st().undo(); assertBorders(4)
    st().redo(); assertBorders(0)
  })

  it('two-edge Unweld chain draws both coincident sides, Weld close removes them, undo restores them', () => {
    const cage = st().cage
    const chain = cageModule.cageEdges(cage).filter(([a, b]) => [a, b].every((p) => cage.positions[p][2] === 40 && cage.positions[p][1] === 0)).map(([a, b]) => edgeKey(a, b))
    expect(chain).toHaveLength(2)
    select(chain); st().unweldSelection(); assertBorders(4)
    expect(st().selection.edges).toHaveLength(4)
    st().weldCloseSelection(); assertBorders(0)
    st().undo(); assertBorders(4)
    st().redo(); assertBorders(0)
  })

  it('Bridge closes two openings; undo and redo update their drawing', () => {
    open(boxCage({ segments: { x: 3, y: 3, z: 3 } }))
    const faces = st().cage.faces.flatMap((f, i) => f.every((p) => Math.abs(st().cage.positions[p][0]) < 7 && Math.abs(st().cage.positions[p][1]) < 7) && (f.every((p) => st().cage.positions[p][2] === 40) || f.every((p) => st().cage.positions[p][2] === 0)) ? [i] : [])
    expect(faces).toHaveLength(2)
    select([], faces); st().deleteSelection(); assertBorders(8)
    select(borderKeys(st().cage)); st().bridgeSelection(); assertBorders(0)
    st().undo(); assertBorders(8)
    st().redo(); assertBorders(0)
  })

  it('plane rim, Thicken, undo and redo; creased borders take precedence and selected/hovered borders stay green', () => {
    open(planeCage({ segments: { x: 2, y: 2, z: 1 } }))
    assertBorders(8)
    const keys = borderKeys(st().cage)
    select(keys); st().crease(true); assertBorders(8)
    expect(lines('form-crease-edges').geometry.getAttribute('position').count).toBe(0)
    overlay.setHighlight(st().cage, st().selection, { kind: 'edge', key: keys[0] })
    const color = (lines().material as THREE.LineBasicMaterial).color.getHex()
    expect(color).toBe(0x4caf50)
    const edgeHighlights = overlay.root.children.flatMap((o) => o.children).filter((o) => o instanceof THREE.LineSegments) as THREE.LineSegments[]
    expect(edgeHighlights).toHaveLength(2)
    for (const highlight of edgeHighlights) {
      expect(lines().renderOrder).toBeGreaterThan(highlight.renderOrder)
      expect(color).not.toBe((highlight.material as THREE.LineBasicMaterial).color.getHex())
    }
    st().thickenForm(); assertBorders(0)
    st().undo(); assertBorders(8)
    st().redo(); assertBorders(0)
  })

  it('Cage and Both show borders, Smooth hides them; positions update without reclassifying topology', () => {
    open(planeCage({ segments: { x: 2, y: 2, z: 1 } }))
    const spy = vi.spyOn(cageModule, 'cageEdgeFaceCounts')
    const attribute = lines().geometry.getAttribute('position')
    for (const mode of ['cage', 'both', 'smooth'] as const) {
      st().setDisplayMode(mode)
      expect(lines().visible).toBe(mode !== 'smooth')
    }
    const cage = st().cage
    st().applyCage({ ...cage, positions: cage.positions.map(([x, y, z]) => [x + 2, y + 4, z + 6]) }, { topology: false, record: true })
    assertBorders(8)
    expect(lines().geometry.getAttribute('position')).toBe(attribute)
    expect(spy).not.toHaveBeenCalled()
    st().undo(); assertBorders(8)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
