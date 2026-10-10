import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { asNumber } from '../../theme/viewportColors'
import type { ToolpathMove } from '../../types'

// WO-2048: while a program runs, the moves already cut are drawn dimmed in
// their own role colour and line weight, and the moves still to come are drawn
// exactly as before.

function methodOnlyViewport() {
  const viewport = Object.create(CNCViewport.prototype) as unknown as
    Pick<CNCViewport, 'renderToolpath' | 'setToolpathDoneBoundary' | 'setHiddenToolpathRoles'> &
    Record<string, unknown>
  viewport.toolpathGroup = new THREE.Group()
  viewport.toolpathRoleLines = new Map<string, THREE.Object3D>()
  viewport.toolpathPickBodies = []
  return viewport
}

const CUT_MOVES: ToolpathMove[] = [
  { type: 'feed', x: 0, y: 0, z: -1, role: 'cut' },
  { type: 'feed', x: 1, y: 0, z: -1, role: 'cut' },
  { type: 'feed', x: 2, y: 0, z: -1, role: 'cut' },
  { type: 'feed', x: 3, y: 0, z: -1, role: 'cut' },
  { type: 'feed', x: 4, y: 0, z: -1, role: 'cut' },
]

const MIXED_MOVES: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' },
  { type: 'rapid', x: 10, y: 0, z: 5, role: 'rapid' },
  { type: 'feed', x: 10, y: 0, z: -1, role: 'cut' },
  { type: 'feed', x: 10, y: 10, z: -1, role: 'cut' },
  { type: 'rapid', x: 10, y: 10, z: 5, role: 'rapid' },
  { type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' },
]

function roleBody(viewport: Record<string, unknown>, role: string): THREE.LineSegments {
  const object = (viewport.toolpathRoleLines as Map<string, THREE.Object3D>).get(role)
  if (!object) throw new Error(`no ${role} body`)
  if (object instanceof THREE.LineSegments) return object
  const body = object.children.find((child) => child instanceof THREE.LineSegments && !child.userData.toolpathDone)
  if (!(body instanceof THREE.LineSegments)) throw new Error(`no ${role} line`)
  return body
}

function doneLine(body: THREE.LineSegments): THREE.LineSegments | undefined {
  return body.children.find((child) => child.userData.toolpathDone) as THREE.LineSegments | undefined
}

function drawnVertices(line: THREE.LineSegments): [number, number] {
  const count = line.geometry.getAttribute('position').count
  const { start, count: range } = line.geometry.drawRange
  return [start, Math.min(count, start + range)]
}

function luminance(color: THREE.Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

describe('WO-2048 CNCViewport done/remaining toolpath boundary', () => {
  it('draws the whole path unchanged until a boundary is set', () => {
    const viewport = methodOnlyViewport()
    viewport.renderToolpath(CUT_MOVES, true)
    const body = roleBody(viewport, 'cut')

    expect(drawnVertices(body)).toEqual([0, 8])
    expect(doneLine(body)).toBeUndefined()

    viewport.setToolpathDoneBoundary(null)
    expect(drawnVertices(body)).toEqual([0, 8])
    expect(doneLine(body)).toBeUndefined()
  })

  it('draws moves before the boundary dimmed in the same hue and weight, and the rest unchanged', () => {
    const viewport = methodOnlyViewport()
    viewport.renderToolpath(CUT_MOVES, true)
    const body = roleBody(viewport, 'cut')
    const bodyColor = (body.material as THREE.LineBasicMaterial).color.clone()

    // Moves 0..2 are done; move 3 is the one running. Segments end at moves
    // 1, 2, 3, 4, so the first two are done.
    viewport.setToolpathDoneBoundary(3)

    expect(drawnVertices(body)).toEqual([4, 8])
    expect((body.material as THREE.LineBasicMaterial).color.getHex()).toBe(bodyColor.getHex())

    const done = doneLine(body)
    expect(done).toBeDefined()
    expect(done!.visible).toBe(true)
    expect(drawnVertices(done!)).toEqual([0, 4])
    // One position buffer per role: moving the boundary never copies the path.
    expect(done!.geometry.getAttribute('position')).toBe(body.geometry.getAttribute('position'))

    const doneMaterial = done!.material as THREE.LineBasicMaterial
    expect(doneMaterial.linewidth).toBe((body.material as THREE.LineBasicMaterial).linewidth)
    const doneHsl = doneMaterial.color.getHSL({ h: 0, s: 0, l: 0 })
    const bodyHsl = bodyColor.getHSL({ h: 0, s: 0, l: 0 })
    expect(Math.abs(doneHsl.h - bodyHsl.h)).toBeLessThan(0.05)
    expect(luminance(doneMaterial.color)).toBeLessThan(luminance(bodyColor) * 0.5)
    // The dimmed colour moves toward the canvas, not toward black or white.
    const canvas = new THREE.Color(asNumber('--vp-canvas'))
    const toCanvas = (c: THREE.Color) => Math.hypot(c.r - canvas.r, c.g - canvas.g, c.b - canvas.b)
    expect(toCanvas(doneMaterial.color)).toBeLessThan(toCanvas(bodyColor) * 0.5)
    // Upcoming moves read over done ones: a done upper step-down in front of
    // an upcoming lower one (Top view) must not hide it.
    expect(done!.renderOrder).toBeLessThan(body.renderOrder)
    expect(doneMaterial.depthWrite).toBe(false)
    expect((body.material as THREE.LineBasicMaterial).depthWrite).toBe(true)
  })

  it('moves the boundary without rebuilding, and null restores the full path', () => {
    const viewport = methodOnlyViewport()
    viewport.renderToolpath(CUT_MOVES, true)
    const body = roleBody(viewport, 'cut')

    viewport.setToolpathDoneBoundary(2)
    const done = doneLine(body)!
    expect(drawnVertices(body)).toEqual([2, 8])
    expect(drawnVertices(done)).toEqual([0, 2])

    viewport.setToolpathDoneBoundary(4)
    expect(roleBody(viewport, 'cut')).toBe(body)
    expect(doneLine(body)).toBe(done)
    expect(drawnVertices(body)).toEqual([6, 8])
    expect(drawnVertices(done)).toEqual([0, 6])

    // Past the last move: everything is done.
    viewport.setToolpathDoneBoundary(99)
    expect(drawnVertices(body)).toEqual([8, 8])
    expect(drawnVertices(done)).toEqual([0, 8])

    viewport.setToolpathDoneBoundary(null)
    expect(drawnVertices(body)).toEqual([0, 8])
    expect(done.visible).toBe(false)
  })

  it('splits every role at the same move, including dashed rapids', () => {
    const viewport = methodOnlyViewport()
    viewport.renderToolpath(MIXED_MOVES, true)
    const rapid = roleBody(viewport, 'rapid')
    const cut = roleBody(viewport, 'cut')

    // Moves 0..3 done: rapid segment ending at 1 and cut segments ending at 2
    // and 3; rapid segments ending at 4 and 5 remain.
    viewport.setToolpathDoneBoundary(4)

    expect(drawnVertices(cut)).toEqual([4, 4])
    expect(drawnVertices(doneLine(cut)!)).toEqual([0, 4])
    expect(drawnVertices(rapid)).toEqual([2, 6])
    const rapidDone = doneLine(rapid)!
    expect(drawnVertices(rapidDone)).toEqual([0, 2])
    expect(rapidDone.material).toBeInstanceOf(THREE.LineDashedMaterial)
    expect(rapidDone.geometry.getAttribute('lineDistance')).toBe(rapid.geometry.getAttribute('lineDistance'))
  })

  it('dims a done rapid move\'s solid end caps with its dashed body', () => {
    const viewport = methodOnlyViewport()
    viewport.renderToolpath(MIXED_MOVES, true)
    const rapidObject = (viewport.toolpathRoleLines as Map<string, THREE.Object3D>).get('rapid')!
    const caps = rapidObject.children.find((child) => child.userData.toolpathEndCaps) as THREE.LineSegments
    expect(caps).toBeInstanceOf(THREE.LineSegments)
    const capColor = (caps.material as THREE.LineBasicMaterial).color.clone()
    // The rapid runs form one chain with two free ends: (10,0,5) on the rapid
    // ending at move 1, and (10,10,-1) on the rapid ending at move 4.
    expect(drawnVertices(caps)).toEqual([0, 4])
    expect(doneLine(caps)).toBeUndefined()

    viewport.setToolpathDoneBoundary(4)
    // The move-1 cap is done and dimmed; the move-4 cap is still to come.
    expect(drawnVertices(caps)).toEqual([2, 4])
    expect((caps.material as THREE.LineBasicMaterial).color.getHex()).toBe(capColor.getHex())
    const done = doneLine(caps)!
    expect(done.visible).toBe(true)
    expect(drawnVertices(done)).toEqual([0, 2])
    const position = done.geometry.getAttribute('position')
    expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([10, 0, 5])
    expect([position.getX(2), position.getY(2), position.getZ(2)]).toEqual([10, 10, -1])
    const doneColor = (done.material as THREE.LineBasicMaterial).color
    expect(doneColor.getHex())
      .toBe((doneLine(roleBody(viewport, 'rapid'))!.material as THREE.LineDashedMaterial).color.getHex())
    expect(luminance(doneColor)).toBeLessThan(luminance(capColor) * 0.5)

    // Past the last move both caps are done; null restores them.
    viewport.setToolpathDoneBoundary(99)
    expect(drawnVertices(caps)).toEqual([4, 4])
    expect(drawnVertices(done)).toEqual([0, 4])
    viewport.setToolpathDoneBoundary(null)
    expect(drawnVertices(caps)).toEqual([0, 4])
    expect(done.visible).toBe(false)
  })

  it('hides the dimmed moves with their role and keeps the boundary across a rebuild', () => {
    const viewport = methodOnlyViewport()
    viewport.renderToolpath(CUT_MOVES, true)
    viewport.setToolpathDoneBoundary(3)
    const oldDone = doneLine(roleBody(viewport, 'cut'))!
    const oldMaterial = oldDone.material as THREE.Material
    let disposed = false
    oldMaterial.addEventListener('dispose', () => { disposed = true })

    viewport.setHiddenToolpathRoles(new Set(['cut']))
    const cutObject = (viewport.toolpathRoleLines as Map<string, THREE.Object3D>).get('cut')!
    expect(cutObject.visible).toBe(false)
    let underRole = false
    oldDone.traverseAncestors((ancestor) => { if (ancestor === cutObject) underRole = true })
    expect(underRole).toBe(true)
    viewport.setHiddenToolpathRoles(new Set())

    // Rebuilding the same program (REM toggling back to ALL does this) keeps
    // the done moves dimmed and frees the old dimmed line.
    viewport.renderToolpath(CUT_MOVES, true)
    expect(disposed).toBe(true)
    const body = roleBody(viewport, 'cut')
    expect(drawnVertices(body)).toEqual([4, 8])
    expect(drawnVertices(doneLine(body)!)).toEqual([0, 4])
  })
})
