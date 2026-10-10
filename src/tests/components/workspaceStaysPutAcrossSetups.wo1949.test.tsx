// WO-1949: selecting an operation (which switches the active setup) must never
// move the grid. WO-1955: not in Z either - the grid is the machine table.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'

type Plane = { origin: { x: number; y: number }; z: number; label: string; resolved: boolean }

function fakeViewport() {
  const proto = CNCViewport.prototype as unknown as Record<string, unknown>
  const vp = {
    gridGroup: new THREE.Group(),
    machinePreviewFrame: null,
    setupSupportPlane: null as unknown,
    machineTravelX: 600,
    machineTravelY: 400,
    gridSpacing: 10,
  }
  const build = () => (proto.buildGrid as (this: unknown) => void).call(vp)
  Object.assign(vp, { buildGrid: build })
  return {
    vp,
    setPlane: (p: Plane | null) =>
      (proto.setSetupSupportPlane as (this: unknown, p: Plane | null) => void).call(vp, p),
    build,
  }
}

describe('WO-1949 workspace stays put across setups', () => {
  it('WO-1955: keeps grid X/Y/Z fixed when the active setup (origin, support plane) changes', () => {
    const { vp, setPlane, build } = fakeViewport()
    build()
    setPlane({ origin: { x: 120, y: 80 }, z: 42, label: 'Setup 1 | G54', resolved: true })
    expect(vp.gridGroup.position.toArray()).toEqual([0, 0, 0])

    setPlane({ origin: { x: -300, y: -150 }, z: 7, label: 'Setup 2 | G56', resolved: true })
    expect(vp.gridGroup.position.toArray()).toEqual([0, 0, 0])
  })
})
