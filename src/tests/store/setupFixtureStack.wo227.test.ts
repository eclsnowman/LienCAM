import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  persistMerge,
  persistPartialize,
  useCamStore,
} from '../../store'
import {
  resolveSetupSupportPlane,
  type FixtureStackItem,
} from '../../lib/cam/types'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { Operation, Setup } from '../../types'

const stack: FixtureStackItem[] = [
  { id: 'layer-spoilboard', name: 'MDF spoilboard', type: 'spoilboard', height: 19, visible: true },
  { id: 'layer-vise', name: 'Kurt vise', type: 'vise', height: 75, visible: true },
  { id: 'layer-soft-jaw', name: 'Op 2 soft jaws', type: 'soft_jaw', height: 20, visible: true },
]

function operation(): Operation {
  return {
    id: 'op-1',
    name: 'Pocket',
    type: 'pocket_2d',
    enabled: true,
    status: 'ready',
    toolId: 'tool-1',
    geometrySelections: [],
    heights: {
      clearanceHeight: 10,
      clearanceHeightMode: 'relative',
      retractHeight: 5,
      feedHeight: 1,
      topHeight: 0,
      topHeightMode: 'absolute',
      bottomHeight: -5,
      bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 1, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 2, rampLength: 5,
      leadInRadius: 1, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
    },
    params: { geometryId: 'part-1' },
    toolpathMoves: [
      { type: 'rapid', x: 1, y: 2, z: 8 },
      { type: 'linear', x: 5, y: 2, z: -1, feedRate: 300 },
    ],
  } as Operation
}

function setup(): Setup {
  return {
    id: 'setup-1',
    name: 'Second op',
    wcs: {
      id: 'wcs-1', label: 'G55', fixtureOffset: 55,
      origin: { x: 40, y: 25, z: 100 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0,
      offsetZTop: 5, offsetZBottom: 0, material: 'aluminum',
    },
    fixtureStack: structuredClone(stack),
    supportPlane: { mode: 'soft_jaw_step', offset: -2 },
    operations: [operation()],
    notes: '',
  }
}

beforeEach(() => {
  useCamStore.setState((state) => ({
    project: {
      ...state.project,
      setups: [setup()],
      activeSetupId: 'setup-1',
      activeOperationId: 'op-1',
    },
    projectHistory: [],
    sketchHistory: [],
    projectFuture: [],
    sketchFuture: [],
    canUndo: false,
    canRedo: false,
  }))
})

describe('WO-227 setup fixture stack', () => {
  it('resolves a spoilboard + vise + soft-jaw stack against nonzero G55', () => {
    const resolved = resolveSetupSupportPlane(setup())
    expect(resolved).toMatchObject({
      name: 'Soft-jaw step',
      z: 112,
      wcsLabel: 'G55',
      wcsOffsetZ: 12,
      resolved: true,
    })
  })

  it('treats visibility as display-only and keeps physical support height', () => {
    const visible = setup()
    const hidden = { ...visible, fixtureStack: visible.fixtureStack!.map((item) => ({ ...item })) }
    hidden.fixtureStack![1].visible = false

    expect(resolveSetupSupportPlane(hidden)).toEqual(resolveSetupSupportPlane(visible))
  })

  it('resolves stock-bottom and custom modes with signed offsets', () => {
    const stockBottom = setup()
    stockBottom.supportPlane = { mode: 'stock_bottom', offset: 1.5 }
    expect(resolveSetupSupportPlane(stockBottom, 42).z).toBe(43.5)
    expect(resolveSetupSupportPlane(stockBottom).resolved).toBe(false)

    const custom = setup()
    custom.supportPlane = { mode: 'custom', customZ: -8, offset: 0.25 }
    expect(resolveSetupSupportPlane(custom)).toMatchObject({
      name: 'Custom plane', z: -7.75, wcsOffsetZ: -107.75, resolved: true,
    })
  })

  it('keeps the last valid grid transform when a support plane is unresolved', () => {
    const existingPlane = {
      origin: { x: 40, y: 25 },
      z: 42,
      label: 'Stock bottom | G55 Z-58.000',
    }
    const viewport = {
      setupSupportPlane: existingPlane,
      machinePreviewFrame: null,
      buildGrid: vi.fn(),
    }
    const setSetupSupportPlane = CNCViewport.prototype.setSetupSupportPlane as unknown as (
      this: typeof viewport,
      input: {
        origin: { x: number; y: number }
        z: number
        label: string
        resolved: boolean
      } | null,
    ) => void

    setSetupSupportPlane.call(viewport, {
      origin: { x: 0, y: 0 },
      z: 1.5,
      label: 'Stock bottom | G55 Z+1.500',
      resolved: false,
    })

    expect(viewport.setupSupportPlane).toBe(existingPlane)
    expect(viewport.buildGrid).not.toHaveBeenCalled()
  })

  it('persists and reloads the setup-owned records', () => {
    const persisted = persistPartialize(useCamStore.getState())
    const current = useCamStore.getState()
    const reloaded = persistMerge(persisted, current)

    expect(reloaded.project.setups[0].fixtureStack).toEqual(stack)
    expect(reloaded.project.setups[0].supportPlane).toEqual({ mode: 'soft_jaw_step', offset: -2 })
    expect(resolveSetupSupportPlane(reloaded.project.setups[0]).z).toBe(112)
  })

  it('undoes a stack/display edit in one step without moving machining geometry', () => {
    const before = structuredClone(useCamStore.getState().project.setups[0])
    useCamStore.getState().updateSetup('setup-1', {
      fixtureStack: before.fixtureStack!.map((item, index) => (
        index === 1 ? { ...item, height: 80, visible: false } : { ...item }
      )),
      supportPlane: { mode: 'vise_bed', offset: 3 },
    })

    const changed = useCamStore.getState().project.setups[0]
    expect(resolveSetupSupportPlane(changed).z).toBe(102)
    expect(changed.wcs).toEqual(before.wcs)
    expect(changed.stock).toEqual(before.stock)
    expect(changed.operations).toEqual(before.operations)
    expect(changed.operations[0].status).toBe('ready')

    useCamStore.getState().undo()
    const restored = useCamStore.getState().project.setups[0]
    expect(restored.fixtureStack).toEqual(before.fixtureStack)
    expect(restored.supportPlane).toEqual(before.supportPlane)
    expect(restored.wcs).toEqual(before.wcs)
    // The shared undo seam intentionally drops cached moves for regeneration;
    // the pre-undo equality above proves this display edit itself did not.
    expect(restored.operations[0].id).toBe(before.operations[0].id)
  })
})
