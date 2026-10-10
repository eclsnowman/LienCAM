import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CNCViewport } from '../../lib/viewport/CNCViewport'

type GridReceiver = {
  gridGroup: THREE.Group
  machineGroup: THREE.Group
  machineTravelBorderGroup: THREE.Group
  machineTravelX: number
  machineTravelY: number
  gridSpacing: number
  colors: { gridAccent: number; grid: number }
}

function receiver(): GridReceiver {
  return {
    gridGroup: new THREE.Group(),
    machineGroup: new THREE.Group(),
    machineTravelBorderGroup: new THREE.Group(),
    machineTravelX: 800,
    machineTravelY: 600,
    gridSpacing: 25,
    colors: { gridAccent: 0x334455, grid: 0x223344 },
  }
}

describe('UI-104 CAM grid and machine-envelope lifecycle', () => {
  it('builds a line grid without an opaque or translucent backing plane', () => {
    const viewport = receiver()
    const buildGrid = (CNCViewport.prototype as unknown as {
      buildGrid: (this: GridReceiver) => void
    }).buildGrid

    buildGrid.call(viewport)

    expect(viewport.gridGroup.children).toHaveLength(1)
    expect(viewport.gridGroup.children[0]).toBeInstanceOf(THREE.GridHelper)
    expect(viewport.gridGroup.children.some((child) => child instanceof THREE.Mesh)).toBe(false)
  })

  it('shows the dashed travel envelope only with the Machine display', () => {
    const viewport = receiver()
    const setMachineVisible = CNCViewport.prototype.setMachineVisible as (
      this: GridReceiver,
      visible: boolean,
    ) => void

    setMachineVisible.call(viewport, false)
    expect(viewport.machineGroup.visible).toBe(false)
    expect(viewport.machineTravelBorderGroup.visible).toBe(false)

    setMachineVisible.call(viewport, true)
    expect(viewport.machineGroup.visible).toBe(true)
    expect(viewport.machineTravelBorderGroup.visible).toBe(true)
  })
})
