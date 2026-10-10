// @vitest-environment jsdom

import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ImportedGeometry } from '../../types'
import { CNCViewport } from '../../lib/viewport/CNCViewport'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: memStorage,
  configurable: true,
})

const { NestModal } = await import('../../components/modals/NestModal')
const { useCamStore } = await import('../../store')

const PART_A = 'part-a'
const PART_B = 'part-b'
let pickedPart: ((id: string) => void) | null = null
let allowedIds: readonly string[] = []
let initialSelectedIds: readonly string[] = []
const selectionUpdates: string[][] = []

function bodyPresentation() {
  const material = new THREE.MeshStandardMaterial()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material)
  mesh.userData.isBodyPresentationMesh = true
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial(),
  )
  edges.userData.isDisplayEdge = true
  mesh.add(edges)
  const group = new THREE.Group()
  group.add(mesh)
  return { group, material }
}

function interactionColor(outline: THREE.Object3D | undefined): number | null {
  let color: number | null = null
  outline?.traverse((child) => {
    if (color !== null || !(child instanceof THREE.Mesh)) return
    const material = child.material as THREE.Material & {
      color?: THREE.Color
      uniforms?: { interactionColor?: { value?: unknown } }
    }
    const uniform = material.uniforms?.interactionColor?.value
    if (uniform instanceof THREE.Color) color = uniform.getHex()
    else if (material.color instanceof THREE.Color) color = material.color.getHex()
  })
  return color
}

function nestableGeometry(id: string, name: string): ImportedGeometry {
  return {
    id,
    name,
    type: 'curves_2d',
    format: 'svg',
    loaded: true,
    loops: [{
      id: `${id}-outer`,
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }],
      closed: true,
      type: 'contour',
      layerId: `${id}-layer`,
      area: 100,
    }],
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 20, y: 10, z: 0 },
    },
  } as ImportedGeometry
}

beforeEach(() => {
  mem.clear()
  act(() => { useCamStore.getState().newProject() })
  const current = useCamStore.getState()
  useCamStore.setState({
    project: {
      ...current.project,
      geometry: [
        nestableGeometry(PART_A, 'Bracket'),
        nestableGeometry(PART_B, 'Gusset'),
      ],
    },
  })
  pickedPart = null
  allowedIds = []
  initialSelectedIds = []
  selectionUpdates.length = 0
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    setPartPickMode: (
      callback: ((id: string) => void) | null,
      eligible: readonly string[] = [],
      selected: readonly string[] = [],
    ) => {
      pickedPart = callback
      allowedIds = eligible
      initialSelectedIds = selected
    },
    setPartPickSelection: (ids: readonly string[]) => {
      selectionUpdates.push([...ids])
    },
  }
})

afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().closeModal() })
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('UI-61 nest membership viewport selection', () => {
  it('multi-toggles eligible parts through the shared picker and keeps the name list as a collapsed fallback', () => {
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    expect(screen.getByTestId('nest-part-pick-banner')).not.toBeNull()
    expect(allowedIds).toEqual([PART_A, PART_B])
    expect(initialSelectedIds).toEqual([])

    const toggle = pickedPart
    expect(toggle).not.toBeNull()
    act(() => { toggle?.(PART_A) })
    expect(selectionUpdates.at(-1)).toEqual([PART_A])
    expect(screen.getByTestId('nest-part-pick-count').textContent).toContain('1 selected')

    act(() => { toggle?.(PART_B) })
    expect(selectionUpdates.at(-1)).toEqual([PART_A, PART_B])
    expect(screen.getByTestId('nest-part-pick-count').textContent).toContain('2 selected')

    act(() => { toggle?.(PART_A) })
    expect(selectionUpdates.at(-1)).toEqual([PART_B])
    fireEvent.click(screen.getByTestId('nest-part-pick-done'))

    expect(screen.queryByTestId('nest-part-pick-banner')).toBeNull()
    expect(pickedPart).toBeNull()
    const fallback = screen.getByTestId('nest-part-name-fallback') as HTMLDetailsElement
    expect(fallback.open).toBe(false)
    expect((screen.getByTestId(`nest-part-check-${PART_A}`) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId(`nest-part-check-${PART_B}`) as HTMLInputElement).checked).toBe(true)

    const reopenedFallback = screen.getByTestId('nest-part-name-fallback') as HTMLDetailsElement
    fireEvent.click(reopenedFallback.querySelector('summary') as HTMLElement)
    expect(reopenedFallback.open).toBe(true)
    fireEvent.click(screen.getByTestId(`nest-part-check-${PART_A}`))
    expect((screen.getByTestId(`nest-part-check-${PART_A}`) as HTMLInputElement).checked).toBe(true)
  })

  it('the shared viewport session paints multiple part ids and preserves ordinary selection', () => {
    const viewport = Object.create(CNCViewport.prototype) as CNCViewport
    const partA = bodyPresentation()
    const partB = bodyPresentation()
    const partAOutline = new THREE.Group()
    partAOutline.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(20, 0, 0),
        new THREE.Vector3(20, 10, 0),
      ]),
      new THREE.LineBasicMaterial(),
    ))
    Object.assign(viewport as unknown as Record<string, unknown>, {
      partMaterials: new Map([[PART_A, partA.material], [PART_B, partB.material]]),
      partGroups: new Map([[PART_A, partA.group], [PART_B, partB.group]]),
      geometry2dGroups: new Map([[PART_A, partAOutline]]),
      projectedLoopGroups: new Map(),
      _worldPlaneLoopGroups: new Map(),
      _geoLocalLoopGroups: new Map(),
      renderer: { getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600) },
      currentShadingMode: 'shaded-edges',
      viewportThemeId: 'classic',
      selectionGlow: 'current',
      selectedPartId: null,
      partPickHoverId: null,
      partPickAllowedIds: new Set([PART_A, PART_B]),
      partPickSelectedIds: new Set(),
      partPickPresentation: 'nest-membership',
      partPickGlowGroups: new Map(),
      partInteractionOutlines: new Map(),
      pickedBrepKeys: new Set(),
      brepHighlights: new Map(),
      brepHoverKey: null,
      brepHoverObj: null,
      sketcher: { refreshGlow: () => undefined },
    })

    viewport.setPartPickSelection([PART_A, PART_B])
    const outlines = (viewport as unknown as {
      partInteractionOutlines: Map<string, THREE.Object3D>
    }).partInteractionOutlines
    expect(interactionColor(outlines.get(PART_A))).toBe(0x4ac3ff)
    expect(interactionColor(outlines.get(PART_B))).toBe(0x4ac3ff)
    expect(partAOutline.getObjectByName('__nest-membership-glow__')?.children).toHaveLength(2)

    ;(viewport as unknown as { selectedPartId: string | null }).selectedPartId = PART_A
    viewport.setPartPickSelection([])
    // WO-346: selection is a geometry-state colour (tokens.css keeps
    // --vp-select-part theme-invariant on purpose), so CNCViewport now reads
    // it straight from asNumber('--vp-select-part') at the call site instead
    // of a per-instance `colors` field a test could override -- the real
    // token's fallback value (0xffaa00) is what production actually paints.
    expect(interactionColor(outlines.get(PART_A))).toBe(0xffaa00)
    expect(outlines.has(PART_B)).toBe(false)
    expect(partAOutline.getObjectByName('__nest-membership-glow__')).toBeUndefined()
    expect(
      ((partAOutline.children[0] as THREE.Line).material as THREE.LineBasicMaterial).color.getHex(),
    ).toBe(0xffaa00)
  })

  it('uses live glow palettes for ordinary whole-part hover and selection with selected priority', () => {
    const viewport = Object.create(CNCViewport.prototype) as CNCViewport
    const partA = bodyPresentation()
    const partB = bodyPresentation()
    Object.assign(viewport as unknown as Record<string, unknown>, {
      partMaterials: new Map([[PART_A, partA.material], [PART_B, partB.material]]),
      partGroups: new Map([[PART_A, partA.group], [PART_B, partB.group]]),
      geometry2dGroups: new Map(),
      projectedLoopGroups: new Map(),
      _worldPlaneLoopGroups: new Map(),
      _geoLocalLoopGroups: new Map(),
      renderer: { getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600) },
      currentShadingMode: 'shaded-edges',
      viewportThemeId: 'brand-blue',
      selectionGlow: 'complementary',
      selectedPartId: null,
      partPickHoverId: null,
      partPickAllowedIds: new Set([PART_A, PART_B]),
      partPickSelectedIds: new Set(),
      partPickPresentation: 'standard',
      partPickGlowGroups: new Map(),
      partInteractionOutlines: new Map(),
      pickedBrepKeys: new Set(),
      brepHighlights: new Map(),
      brepHoverKey: null,
      brepHoverObj: null,
      sketcher: { refreshGlow: () => undefined },
    })

    viewport.setPartPickSelection([PART_A])
    const setHover = (viewport as unknown as {
      setPartPickHover: (id: string | null) => void
    }).setPartPickHover.bind(viewport)
    setHover(PART_B)
    const outlines = (viewport as unknown as {
      partInteractionOutlines: Map<string, THREE.Object3D>
    }).partInteractionOutlines
    const selectedOutline = outlines.get(PART_A)
    const hoveredOutline = outlines.get(PART_B)
    expect(interactionColor(selectedOutline)).toBe(0xff2fb0)
    expect(interactionColor(hoveredOutline)).toBe(0xd8b4fe)
    expect(partA.material.color.getHex()).toBe(0xff2fb0)
    expect(partA.material.opacity).toBe(1)
    expect(partA.material.transparent).toBe(false)
    expect(partB.material.color.getHex()).toBe(0xffffff)

    viewport.setSelectionGlow('signature')
    const signatureSelected = outlines.get(PART_A)
    expect(signatureSelected).toBe(selectedOutline)
    expect(outlines.get(PART_B)).toBe(hoveredOutline)
    expect(signatureSelected?.userData.interactionKind).toBe('body-outline')
    expect(signatureSelected?.children).toHaveLength(0)
    expect(interactionColor(signatureSelected)).toBe(0xffa21a)
    expect(partA.material.color.getHex()).toBe(0xffa21a)
    expect(interactionColor(outlines.get(PART_B))).toBe(0xffbd5a)

    setHover(PART_A)
    expect(interactionColor(outlines.get(PART_A))).toBe(0xffa21a)
    expect(outlines.has(PART_B)).toBe(false)
  })
})
