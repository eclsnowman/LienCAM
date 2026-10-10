// @vitest-environment jsdom
//
// WO-1573: a body marked workholding (WO-1572's setGeometryWorkholding /
// isWorkholdingGeometry) must (1) draw in its own muted viewport style,
// distinct from a part or stock, (2) show in its own group in the design
// tree, and (3) get a Workholding toggle on the Properties panel that drives
// the same store action. The move/rotate gizmo needs no change (it already
// keys off the part group's origin/proxy convention, not any geometry flag)
// -- covered here by asserting a workholding body still resolves the same
// direct-attach pivot convention addSTL bakes into every recentred mesh.
//
// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store (same
// scaffolding as PropertiesPanelGeoSwatch.test.tsx / DesignTreeAutoStock.smoke.test.tsx).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

import * as THREE from 'three'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => new ArrayBuffer(84)),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { CNCViewport } = await import('../../lib/viewport/CNCViewport')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
  })
  delete (window as unknown as { __cncViewport?: unknown }).__cncViewport
})

function meshGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-part-1', name: 'Bracket', filename: 'bracket.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...over,
  } as ImportedGeometry
}

describe('WO-1573: Properties panel Workholding toggle', () => {
  it('renders Off for an ordinary part and calls setGeometryWorkholding + the viewport recolor on click', () => {
    const geo = meshGeo()
    const setPartWorkholding = vi.fn()
    act(() => {
      useCamStore.getState().addGeometry(geo)
      useCamStore.getState().setSelectedGeometry(geo.id)
    })
    ;(window as unknown as { __cncViewport: unknown }).__cncViewport = { setPartWorkholding }

    render(<PropertiesPanel />)
    const row = screen.getByTestId('geo-workholding-toggle-row')
    const checkbox = within(row).getByTestId('geo-workholding-toggle') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    expect(within(row).getByText('Off')).toBeTruthy()

    fireEvent.click(checkbox)

    const marked = useCamStore.getState().project.geometry.find((g) => g.id === geo.id)
    expect(marked?.workholding).toBe(true)
    expect(setPartWorkholding).toHaveBeenCalledWith(geo.id, true, geo.color)
    expect(within(screen.getByTestId('geo-workholding-toggle-row')).getByText('On')).toBeTruthy()

    // Toggling back off writes the mark false and recolors again.
    fireEvent.click(screen.getByTestId('geo-workholding-toggle'))
    const unmarked = useCamStore.getState().project.geometry.find((g) => g.id === geo.id)
    // setGeometryWorkholding clears the mark to undefined, not false (WO-1572).
    expect(unmarked?.workholding).toBeUndefined()
    expect(setPartWorkholding).toHaveBeenLastCalledWith(geo.id, false, geo.color)
  })

  it('a body already marked workholding renders On', () => {
    const geo = meshGeo({ workholding: true })
    act(() => {
      useCamStore.getState().addGeometry(geo)
      useCamStore.getState().setSelectedGeometry(geo.id)
    })
    render(<PropertiesPanel />)
    const row = screen.getByTestId('geo-workholding-toggle-row')
    expect((within(row).getByTestId('geo-workholding-toggle') as HTMLInputElement).checked).toBe(true)
    expect(within(row).getByText('On')).toBeTruthy()
  })
})

describe('WO-1573: design tree groups workholding separately', () => {
  it('a plain part renders at the root; a workholding-marked body renders inside the Workholding group instead', () => {
    const part = meshGeo({ id: 'part-1', name: 'Bracket' })
    const vise = meshGeo({ id: 'vise-1', name: 'Kurt vise', workholding: true })
    act(() => {
      useCamStore.getState().addGeometry(part)
      useCamStore.getState().addGeometry(vise)
    })
    render(<DesignTree />)

    const group = screen.getByTestId('tree-workholding-group')
    expect(within(group).getByText('Kurt vise')).toBeTruthy()
    expect(within(group).queryByText('Bracket')).toBeNull()

    // The plain part sits outside the workholding group.
    const geometrySection = screen.getByTestId('geometry-section')
    expect(within(geometrySection).getByText('Bracket')).toBeTruthy()
    expect(group.contains(within(geometrySection).getByText('Bracket'))).toBe(false)

    // Collapsing the group hides its contents (reuses the folder-collapse
    // affordance) without touching the plain part row.
    fireEvent.click(screen.getByTestId('tree-workholding-row'))
    expect(within(screen.getByTestId('tree-workholding-group')).queryByText('Kurt vise')).toBeNull()
    expect(screen.getByText('Bracket')).toBeTruthy()
  })

  it('toggling the mark through the real store action moves the row between the two locations', () => {
    const geo = meshGeo({ id: 'geo-2', name: 'Toggle Body' })
    act(() => { useCamStore.getState().addGeometry(geo) })
    render(<DesignTree />)

    expect(screen.queryByTestId('tree-workholding-group')).toBeNull()
    expect(screen.getByText('Toggle Body')).toBeTruthy()

    act(() => { useCamStore.getState().setGeometryWorkholding(geo.id, true) })
    expect(within(screen.getByTestId('tree-workholding-group')).getByText('Toggle Body')).toBeTruthy()

    act(() => { useCamStore.getState().setGeometryWorkholding(geo.id, false) })
    expect(screen.queryByTestId('tree-workholding-group')).toBeNull()
    expect(screen.getByText('Toggle Body')).toBeTruthy()
  })
})

// ---- Viewport style + gizmo (real CNCViewport prototype methods over a
// minimal instance -- same harness shape as geometry3dMoveGizmoPivot.test.ts) ----

class FakeTransformControls {
  object: THREE.Object3D | undefined
  attach(object: THREE.Object3D) { this.object = object; return this }
  detach() { this.object = undefined; return this }
  setMode(): void {}
}

interface VpUnderTest {
  addSTL: InstanceType<typeof CNCViewport>['addSTL']
  addBrepModel: InstanceType<typeof CNCViewport>['addBrepModel']
  setSelectedPart: InstanceType<typeof CNCViewport>['setSelectedPart']
  setPartWorkholding: InstanceType<typeof CNCViewport>['setPartWorkholding']
  setViewportTheme: InstanceType<typeof CNCViewport>['setViewportTheme']
  partGroups: Map<string, THREE.Group>
  partMaterials: Map<string, THREE.MeshStandardMaterial>
  transformControls: FakeTransformControls
}

function makeVp(): VpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    partGroups: new Map<string, THREE.Group>(),
    partMaterials: new Map(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    selectedPartId: null,
    geometry2dGizmoProxy: null,
    geometry2dGizmoGroup: null,
    geometry2dGizmoLastWorld: new THREE.Matrix4(),
    workpieceGroup: new THREE.Group(),
    scene: new THREE.Scene(),
    viewportThemeId: 'classic',
    partUsesThemeColor: new Map<string, boolean>(),
    partEdgePositions: new Map<string, Float32Array>(),
    partPickPresentation: 'standard',
    partPickSelectedIds: new Set<string>(),
    partPickGlowGroups: new Map<string, THREE.Group>(),
    partPickHoverId: null,
    pickedBrepKeys: new Set<string>(),
    brepHighlights: new Map<string, THREE.Object3D>(),
    brepHoverKey: null,
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
    transformControls: new FakeTransformControls(),
    controls: { enabled: true },
    interactionMode: 'normal',
    sketcher: { isActive: () => false },
    wcsGizmoSphere: null,
    stockGizmoSphere: null,
    stockGizmoId: null,
    rebuildStock: () => {},
    updateSelectableObjects: () => {},
    maybeAutoFit: () => {},
    highlight2D: () => {},
    highlightProjectedLoops: () => {},
  })
  vp.scene.add(vp.workpieceGroup)
  return vp as VpUnderTest
}

/** Minimal binary STL: two triangles spanning the given box. */
function boxStlBuffer(min: [number, number, number], max: [number, number, number]): ArrayBuffer {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const tris = [
    [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0]],
    [[x0, y0, z0], [x1, y1, z1], [x0, y1, z1]],
  ]
  const buf = new ArrayBuffer(84 + tris.length * 50)
  const dv = new DataView(buf)
  dv.setUint32(80, tris.length, true)
  let o = 84
  for (const tri of tris) {
    o += 12
    for (const [x, y, z] of tri) {
      dv.setFloat32(o, x, true)
      dv.setFloat32(o + 4, y, true)
      dv.setFloat32(o + 8, z, true)
      o += 12
    }
    o += 2
  }
  return buf
}

const WORKHOLDING_HEX = (CNCViewport as unknown as { WORKHOLDING_BODY_HEX: string }).WORKHOLDING_BODY_HEX

describe('WO-1573: CNCViewport paints a workholding body in its own muted style', () => {
  beforeEach(() => {
    act(() => { useCamStore.getState().newProject() })
  })

  it('a workholding-marked row gets the fixed muted fill on import, distinct from an ordinary part', async () => {
    act(() => {
      useCamStore.getState().addGeometry(meshGeo({ id: 'part', workholding: undefined }))
      useCamStore.getState().addGeometry(meshGeo({ id: 'vise', workholding: true }))
    })
    const vp = makeVp()
    await vp.addSTL(boxStlBuffer([0, 0, 0], [10, 10, 10]), 'part', 'Part')
    await vp.addSTL(boxStlBuffer([0, 0, 0], [10, 10, 10]), 'vise', 'Vise')

    const partColor = vp.partMaterials.get('part')!.color
    const viseColor = vp.partMaterials.get('vise')!.color
    expect(viseColor.equals(new THREE.Color(WORKHOLDING_HEX))).toBe(true)
    expect(partColor.equals(viseColor)).toBe(false)
  })

  it('setPartWorkholding live-recolors an existing part without a full re-add, and restores the prior color when unmarked', async () => {
    act(() => { useCamStore.getState().addGeometry(meshGeo({ id: 'part' })) })
    const vp = makeVp()
    await vp.addSTL(boxStlBuffer([0, 0, 0], [10, 10, 10]), 'part', 'Part')
    const originalColor = vp.partMaterials.get('part')!.color.clone()

    vp.setPartWorkholding('part', true)
    expect(vp.partMaterials.get('part')!.color.equals(new THREE.Color(WORKHOLDING_HEX))).toBe(true)

    vp.setPartWorkholding('part', false)
    expect(vp.partMaterials.get('part')!.color.equals(originalColor)).toBe(true)
  })

  it('a live viewport-theme switch never repaints a workholding body (unlike an ordinary theme-default part)', async () => {
    act(() => {
      useCamStore.getState().addGeometry(meshGeo({ id: 'part' }))
      useCamStore.getState().addGeometry(meshGeo({ id: 'vise', workholding: true }))
    })
    const vp = makeVp()
    await vp.addSTL(boxStlBuffer([0, 0, 0], [10, 10, 10]), 'part', 'Part')
    await vp.addSTL(boxStlBuffer([0, 0, 0], [10, 10, 10]), 'vise', 'Vise')
    const partBefore = vp.partMaterials.get('part')!.color.clone()
    const viseBefore = vp.partMaterials.get('vise')!.color.clone()

    vp.setViewportTheme('brand-blue')

    expect(vp.partMaterials.get('vise')!.color.equals(viseBefore)).toBe(true)
    expect(vp.partMaterials.get('part')!.color.equals(partBefore)).toBe(false)
  })

  it('the move gizmo attaches to a workholding body directly, exactly as it does on a part (STL recentring pivot)', async () => {
    act(() => { useCamStore.getState().addGeometry(meshGeo({ id: 'vise', workholding: true })) })
    const vp = makeVp()
    await vp.addSTL(boxStlBuffer([0, 0, 0], [10, 10, 10]), 'vise', 'Vise')
    vp.setSelectedPart('vise')

    const group = vp.partGroups.get('vise')!
    expect(group.userData.originIsVisiblePivot).toBe(true)
    expect(vp.transformControls.object).toBe(group)
  })
})
