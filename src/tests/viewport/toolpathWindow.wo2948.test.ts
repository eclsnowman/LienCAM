import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { selectToolpathWindow, type WindowFrame } from '../../lib/simulation/toolpathWindow'

type TestViewport = Pick<CNCViewport, 'setSimulationToolpathWindow' | 'setSimulationToolpathPreview' | 'setHiddenToolpathRoles' | 'setToolpathVisible'> & Record<string, unknown>
function viewport() {
  const vp = Object.create(CNCViewport.prototype) as TestViewport
  vp.toolpathGroup = new THREE.Group()
  vp.toolpathRoleLines = new Map()
  return vp
}
const path: WindowFrame[] = Array.from({ length: 100 }, (_, i) => ({
  fromX: i, fromY: 0, fromZ: 0, toX: i + 1, toY: 0, toZ: 0,
  startMs: i * 100, durationMs: 100, role: i % 2 ? 'rapid' : 'cut',
}))
const group = (vp: TestViewport) => vp.simulationToolpathGroup as THREE.Group
const lines = (vp: TestViewport) => {
  const out: THREE.LineSegments[] = []
  group(vp).traverse(o => { if (o instanceof THREE.LineSegments) out.push(o) })
  return out
}

describe('WO-2948 reusable trail overlay', () => {
  it('reuses bounded buffers on ticks/seeks and separates recent opacity from upcoming', () => {
    const vp = viewport()
    vp.setSimulationToolpathWindow(selectToolpathWindow(path, 50, 5050))
    const initial = lines(vp)
    expect(initial).toHaveLength(4)
    const buffers = initial.map(l => l.geometry.getAttribute('position').array)
    const disposals = initial.map(l => vi.spyOn(l.geometry, 'dispose'))
    for (let i = 0; i < 100; i++) vp.setSimulationToolpathWindow(selectToolpathWindow(path, 51, 5100 + i))
    expect(lines(vp)).toEqual(initial)
    expect(lines(vp).map(l => l.geometry.getAttribute('position').array)).toEqual(buffers)
    expect(disposals.every(spy => spy.mock.calls.length === 0)).toBe(true)
    for (const line of initial) {
      expect(line.geometry.getAttribute('position').count).toBe(128)
      expect(line.geometry.drawRange.count).toBeLessThanOrEqual(128)
      const mat = line.material as THREE.LineBasicMaterial
      expect(mat.depthTest).toBe(false)
      expect(mat.opacity).toBe(line.userData.toolpathWindowPhase === 'recent' ? 0.4 : 1)
    }
    expect(initial.some(l => l.material instanceof THREE.LineDashedMaterial)).toBe(true)
  })

  it('honors role/global filters, restores layer then static, and disposes retired buffers', () => {
    const vp = viewport()
    vp.setHiddenToolpathRoles(new Set(['rapid']))
    vp.setSimulationToolpathWindow(selectToolpathWindow(path, 50, 5050))
    const roleMap = vp.simulationToolpathRoleLines as Map<string, THREE.Object3D>
    expect(roleMap.get('rapid')?.visible).toBe(false)
    vp.setHiddenToolpathRoles(new Set(['cut']))
    expect(roleMap.get('rapid')?.visible).toBe(true)
    expect(roleMap.get('cut')?.visible).toBe(false)
    vp.setToolpathVisible(false)
    expect(group(vp).visible).toBe(false)
    vp.setToolpathVisible(true)
    expect(group(vp).visible).toBe(true)
    const disposals = lines(vp).map(l => vi.spyOn(l.geometry, 'dispose'))
    vp.setSimulationToolpathPreview([
      { type: 'feed', x: 0, y: 0, z: 0, role: 'cut' },
      { type: 'feed', x: 1, y: 0, z: 0, role: 'cut' },
    ])
    expect(disposals.every(spy => spy.mock.calls.length === 1)).toBe(true)
    expect((vp.toolpathGroup as THREE.Group).visible).toBe(false)
    vp.setSimulationToolpathWindow(null)
    expect((vp.toolpathGroup as THREE.Group).visible).toBe(true)
    expect(group(vp).children).toHaveLength(0)
  })

  it('keeps empty windows empty and lets existing Control preview calls supersede them', () => {
    const vp = viewport()
    vp.setSimulationToolpathWindow([])
    expect((vp.toolpathGroup as THREE.Group).visible).toBe(false)
    vp.setSimulationToolpathPreview(null)
    expect((vp.toolpathGroup as THREE.Group).visible).toBe(true)
    vp.setToolpathVisible(false)
    vp.setSimulationToolpathWindow(null)
    expect((vp.toolpathGroup as THREE.Group).visible).toBe(false)
  })
})
