import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  CNCViewport,
  machinePreviewGridAxisCoordinates,
  resolveMachinePreviewCoordinateFrame,
} from '../../lib/viewport/CNCViewport'

const COLORS = {
  grid: 0x222222,
  gridAccent: 0x777777,
  xAxis: 0xff0000,
  yAxis: 0x00ff00,
  zAxis: 0x0000ff,
  wcsOrigin: 0xaa00ff,
}

function methodViewport() {
  const viewport = Object.create(CNCViewport.prototype) as CNCViewport & Record<string, unknown>
  Object.assign(viewport, {
    programFrameGroup: new THREE.Group(),
    gridGroup: new THREE.Group(),
    machineTravelBorderGroup: new THREE.Group(),
    wcsGroup: new THREE.Group(),
    colors: COLORS,
    gridSpacing: 25,
    machineTravelX: 800,
    machineTravelY: 600,
    machinePreviewFrame: null,
  })
  return viewport
}

describe('WO-224 CNCViewport machine/WCS grid frames', () => {
  it('resolves asymmetric GRBL travel from machine zero instead of centering it', () => {
    const frame = resolveMachinePreviewCoordinateFrame({
      programOriginMachine: { x: -120, y: -80, z: 0 },
      grid: {
        travel: { x: 800, y: 600 },
        originMachine: { x: 0, y: 0, z: 0 },
      },
    })

    expect(frame.programTranslation).toEqual({ x: -120, y: -80, z: 0 })
    expect(frame.grid).toMatchObject({ minX: -800, maxX: 0, minY: -600, maxY: 0 })
    expect(frame.grid!.minX + frame.grid!.maxX).not.toBe(0)
    expect(frame.grid!.minY + frame.grid!.maxY).not.toBe(0)
  })

  it('phases finite grid lines through the selected WCS origin and clips to travel', () => {
    const lines = machinePreviewGridAxisCoordinates(-200, 0, -35, 25)
    expect(lines.map((line) => line.coordinate)).toEqual([-185, -160, -135, -110, -85, -60, -35, -10])
    expect(lines.find((line) => line.coordinate === -35)?.accent).toBe(true)
    expect(lines.every((line) => line.coordinate >= -200 && line.coordinate <= 0)).toBe(true)
  })

  it('moves path and cutter through one program parent while the WCS origin stays machine-authored', () => {
    const viewport = methodViewport()
    const internal = viewport as unknown as {
      programFrameGroup: THREE.Group
      gridGroup: THREE.Group
      machineTravelBorderGroup: THREE.Group
      wcsGroup: THREE.Group
    }
    const pathPoint = new THREE.Object3D()
    const cutter = new THREE.Object3D()
    pathPoint.position.set(10, 20, -2)
    cutter.position.copy(pathPoint.position)
    internal.programFrameGroup.add(pathPoint, cutter)

    viewport.setMachinePreviewCoordinateFrame({
      programOriginMachine: { x: -100, y: -50, z: 3 },
      grid: {
        travel: { x: 300, y: 200 },
        originMachine: { x: -25, y: -75, z: -4 },
      },
    })

    expect(pathPoint.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([-90, -30, 1])
    expect(cutter.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([-90, -30, 1])
    expect(internal.gridGroup.visible).toBe(true)
    expect(internal.machineTravelBorderGroup.visible).toBe(true)
    const originMarker = internal.wcsGroup.children.at(-1)!
    expect(originMarker.position.toArray()).toEqual([-25, -75, -4])
    expect((originMarker as THREE.Mesh).geometry).toBeInstanceOf(THREE.SphereGeometry)
    expect(((originMarker as THREE.Mesh).geometry as THREE.SphereGeometry).parameters.radius).toBe(1.8)

    const gridBox = new THREE.Box3().setFromObject(internal.gridGroup)
    expect(gridBox.min.x).toBe(-300)
    expect(gridBox.max.x).toBe(0)
    expect(gridBox.min.y).toBe(-200)
    expect(gridBox.max.y).toBe(0)
  })

  it('hides authoritative geometry when the offset or travel contract is invalid', () => {
    const viewport = methodViewport()
    const internal = viewport as unknown as {
      gridGroup: THREE.Group
      machineTravelBorderGroup: THREE.Group
      wcsGroup: THREE.Group
    }
    viewport.setMachinePreviewCoordinateFrame({
      programOriginMachine: null,
      grid: {
        travel: { x: 300, y: 0 },
        originMachine: { x: 0, y: 0, z: 0 },
      },
    })

    expect(internal.gridGroup.visible).toBe(false)
    expect(internal.machineTravelBorderGroup.visible).toBe(false)
    expect(internal.wcsGroup.visible).toBe(false)
    expect(internal.gridGroup.children).toHaveLength(0)
    expect(internal.wcsGroup.children).toHaveLength(0)
  })
})
