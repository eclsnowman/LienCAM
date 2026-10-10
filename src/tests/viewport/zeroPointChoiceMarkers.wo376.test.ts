// @vitest-environment jsdom

import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { refreshViewportColors } from '../../theme/viewportColors'

type ChoiceStyle = {
  fill: string
  outline: string
  labelBorder: string
  labelBackground: string
  labelText: string
}

type MarkerHarness = {
  zeroPointChoiceGroup: THREE.Group | null
  zeroPointChoiceHoverId: string | null
  zeroPointChoiceAtCurrentRay: () => string | null
  refreshZeroPointChoiceTheme: () => void
  syncThemeIfChanged: () => void
  lastSeenThemeAttr: string | null
  raycaster: { intersectObjects: ReturnType<typeof vi.fn> }
}

function priv(viewport: CNCViewport): MarkerHarness {
  return viewport as unknown as MarkerHarness
}

const DEFAULT = {
  accentStrong: '#2e6db8',
  focus: '#6fb3ff',
  accent: '#4a90d9',
  active: '#7ec0ff',
}

const AMBER = {
  accentStrong: '#c9902f',
  focus: '#ffc978',
  accent: '#e0a94f',
  active: '#ffd878',
}

function installTheme(colors: typeof DEFAULT) {
  const style = document.documentElement.style
  style.setProperty('--accent-strong', colors.accentStrong)
  style.setProperty('--focus-ring', colors.focus)
  style.setProperty('--accent', colors.accent)
  style.setProperty('--text-active', colors.active)
  style.setProperty('--surface-input', '#0c1118')
  style.setProperty('--text-primary', '#f2f7ff')
  style.setProperty('--vp-grid-accent', colors.accentStrong)
  style.setProperty('--vp-stock-edge', colors.focus)
  style.setProperty('--vp-canvas', '#111418')
  style.setProperty('--role-unknown', '#ffffff')
}

function makeContext(): CanvasRenderingContext2D {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  } as unknown as CanvasRenderingContext2D
}

function makeViewport() {
  const viewport = Object.create(CNCViewport.prototype) as CNCViewport
  const canvas = document.createElement('canvas')
  const scene = new THREE.Scene()
  const intersectObjects = vi.fn((
    _objects: THREE.Object3D[],
    _recursive: boolean,
  ): Array<{ object: THREE.Object3D }> => [])
  Object.assign(viewport, {
    scene,
    renderer: {
      domElement: canvas,
      setClearColor: vi.fn(),
    },
    zeroPointChoiceGroup: null,
    zeroPointChoiceCallback: null,
    zeroPointChoiceHoverId: null,
    handleZeroPointChoiceMove: vi.fn(),
    raycaster: { intersectObjects },
    buildGrid: vi.fn(),
    rebuildStock: vi.fn(),
    lastSeenThemeAttr: null,
  })
  viewport.setZeroPointChoices([
    { id: 'top', label: 'TOP', position: { x: 10, y: 20, z: 8 } },
    { id: 'bottom', label: 'BOTTOM', position: { x: 10, y: 20, z: 2 } },
  ], vi.fn())
  return { viewport, h: priv(viewport), intersectObjects }
}

function marker(group: THREE.Group, id: string): THREE.Group {
  const target = group.getObjectByName(`__zero_point_choice_${id}__`)
  if (!(target instanceof THREE.Group)) throw new Error(`missing ${id} marker`)
  return target
}

function radius(target: THREE.Group, name: string): number {
  const mesh = target.getObjectByName(name)
  if (!(mesh instanceof THREE.Mesh) || !(mesh.geometry instanceof THREE.SphereGeometry)) {
    throw new Error(`missing sphere ${name}`)
  }
  return mesh.geometry.parameters.radius
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('style')
  installTheme(DEFAULT)
  refreshViewportColors()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(makeContext())
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('style')
  refreshViewportColors()
})

describe('WO-376 setup-origin choice markers', () => {
  it('shrinks the visible pip but preserves the old 10 mm acquisition diameter with a separate invisible hit sphere', () => {
    const { h, intersectObjects } = makeViewport()
    const group = h.zeroPointChoiceGroup!
    const top = marker(group, 'top')

    expect(radius(top, '__zero_point_choice_fill__')).toBe(2.2)
    expect(radius(top, '__zero_point_choice_outline__')).toBe(3.15)
    expect(radius(top, '__zero_point_choice_hit__')).toBe(5)

    const hit = top.getObjectByName('__zero_point_choice_hit__') as THREE.Mesh
    const hitMaterial = hit.material as THREE.MeshBasicMaterial
    expect(hitMaterial.transparent).toBe(true)
    expect(hitMaterial.opacity).toBe(0)
    expect(hitMaterial.colorWrite).toBe(false)

    intersectObjects.mockReturnValue([{ object: hit }])
    expect(h.zeroPointChoiceAtCurrentRay()).toBe('top')
    expect(intersectObjects).toHaveBeenCalledWith([
      marker(group, 'top').getObjectByName('__zero_point_choice_hit__'),
      marker(group, 'bottom').getObjectByName('__zero_point_choice_hit__'),
    ], false)
  })

  it('uses identity/focus colors for base and hover, then repaints existing markers when Amber is applied', () => {
    const { h } = makeViewport()
    const group = h.zeroPointChoiceGroup!
    const top = marker(group, 'top')
    const bottom = marker(group, 'bottom')

    expect(top.userData.zeroPointChoiceAppearance as ChoiceStyle).toMatchObject({
      fill: DEFAULT.accentStrong,
      outline: DEFAULT.focus,
      labelBorder: DEFAULT.focus,
    })

    h.zeroPointChoiceHoverId = 'top'
    h.refreshZeroPointChoiceTheme()
    expect(top.userData.zeroPointChoiceAppearance as ChoiceStyle).toMatchObject({
      fill: DEFAULT.accent,
      outline: DEFAULT.active,
      labelBorder: DEFAULT.active,
    })
    expect(top.scale.x).toBe(1.12)
    expect(bottom.scale.x).toBe(1)

    installTheme(AMBER)
    document.documentElement.setAttribute('data-theme', 'amber')
    h.syncThemeIfChanged()

    expect(top.userData.zeroPointChoiceAppearance as ChoiceStyle).toMatchObject({
      fill: AMBER.accent,
      outline: AMBER.active,
      labelBorder: AMBER.active,
    })
    expect(bottom.userData.zeroPointChoiceAppearance as ChoiceStyle).toMatchObject({
      fill: AMBER.accentStrong,
      outline: AMBER.focus,
      labelBorder: AMBER.focus,
    })
    const topFill = top.getObjectByName('__zero_point_choice_fill__') as THREE.Mesh
    const bottomOutline = bottom.getObjectByName('__zero_point_choice_outline__') as THREE.Mesh
    expect((topFill.material as THREE.MeshBasicMaterial).color.getHexString()).toBe(AMBER.accent.slice(1))
    expect((bottomOutline.material as THREE.MeshBasicMaterial).color.getHexString()).toBe(AMBER.focus.slice(1))
  })
})
