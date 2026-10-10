import { describe, expect, it } from 'vitest'

import {
  operationGenerationIsCurrent,
  projectOperationFingerprint,
  reconcileProjectGenerationFreshness,
} from '../../lib/cam/generationFingerprint'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'
import type {
  Operation,
  Project,
  ResolvedHeightSnapshotV1,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types'

const GEOMETRY_POSITION_Z = 7
const WCS_ORIGIN_Z = 2
// No real operation remains unwired after WO-1196; this synthetic value keeps
// the corrupt/future-project refusal invariant from rotating again.
const NEVER_WIRED_3D = '__never_wired_3d' as Operation['type']

const tool = {
  id: 'tool-cam17', name: 'CAM-17 tool', type: 'flat_end_mill', diameter: 6,
} as Tool

const truthfulSnapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  // Adaptive actual truth after CAM-16: the strategy's returned top/bottom,
  // stored in both WCS and world-machine frames after geometry placement.
  wcs: { clearance: 20, retract: 13, feed: 13, top: 12, bottom: 5 },
  machine: { clearance: 22, retract: 15, feed: 15, top: 14, bottom: 7 },
  intent: defaultHeightIntent(),
  dependencyIds: ['setup-cam17', 'stock-cam17', 'geo-cam17', tool.id],
}

const truthfulMoves: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 22, role: 'rapid' },
  { type: 'feed', x: 1, y: 1, z: 14, feed: 300, role: 'ramp' },
  { type: 'feed', x: 2, y: 2, z: 7, feed: 300, role: 'cut' },
  { type: 'rapid', x: 2, y: 2, z: 22, role: 'rapid' },
]

function readyProject(
  snapshot: ResolvedHeightSnapshotV1 = truthfulSnapshot,
  moves: ToolpathMove[] = truthfulMoves,
): Project {
  const operation = {
    id: 'op-cam17', name: 'Adaptive actual truth', type: 'adaptive_3d',
    enabled: true, status: 'ready', toolId: tool.id,
    geometrySelections: ['geo-cam17'],
    heights: {
      clearanceHeight: 20, clearanceHeightMode: 'absolute', retractHeight: 13,
      feedHeight: 13, topHeight: 0, topHeightMode: 'stock_top', bottomHeight: -3,
      bottomHeightMode: 'absolute', heightIntent: defaultHeightIntent(),
    },
    passes: {
      stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0,
    },
    linking: {
      entryType: 'plunge', rampAngle: 2, rampLength: 5, leadInRadius: 0,
      leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    params: {},
    // Smart Height V2 is the only authority (2e5678b7): a current operation
    // carries its envelope, its resolved V2 plan, the V1 snapshot and a
    // fingerprint over all of them, or freshness refuses it (ADR-0040).
    smartHeight: smartHeightAuthorityFixture('adaptive_3d'),
    resolvedHeights: snapshot,
    toolpathMoves: moves,
  } as Operation
  operation.resolvedHeightPlan = smartHeightPlanFixture(operation, snapshot)
  const setup = {
    id: 'setup-cam17', name: 'Translated setup',
    wcs: {
      id: 'wcs-cam17', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: WCS_ORIGIN_Z },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      stockId: 'stock-cam17',
    },
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0,
      offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations: [operation],
    notes: '',
  } as Setup
  const project = {
    id: 'project-cam17', name: 'CAM-17 translated project', version: '1', schemaVersion: 11,
    machine: { id: 'machine-cam17', name: 'Machine', rapidRate: 1000 },
    geometry: [{
      id: 'geo-cam17', name: 'Translated geometry', format: 'step', stockId: 'stock-cam17',
      position: { x: 0, y: 0, z: GEOMETRY_POSITION_Z },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: -7 }, max: { x: 10, y: 10, z: 7 },
        size: { x: 10, y: 10, z: 14 }, center: { x: 5, y: 5, z: 0 },
      },
    }],
    setups: [setup],
    stocks: [{ id: 'stock-cam17', name: 'Stock', mode: 'derived' }],
    sceneStock: {
      mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0,
      fixedWidth: 10, fixedHeight: 10, fixedDepth: 14, fixedStocks: [],
    },
    toolLibrary: [tool],
  } as unknown as Project
  operation.generationFingerprint = projectOperationFingerprint(
    project, setup, operation, snapshot, tool,
  )
  return project
}

function loadedOperation(project: Project): Operation {
  return project.setups[0].operations[0]
}

function restampOperation(
  project: Project,
  type: Operation['type'],
  moves: ToolpathMove[] = truthfulMoves,
): Project {
  const setup = project.setups[0]
  const operation = setup.operations[0]
  operation.type = type
  operation.smartHeight = smartHeightAuthorityFixture(type)
  operation.resolvedHeightPlan = smartHeightPlanFixture(operation, operation.resolvedHeights!)
  operation.toolpathMoves = moves
  operation.generationFingerprint = projectOperationFingerprint(
    project, setup, operation, operation.resolvedHeights!, tool,
  )
  return project
}

describe('CAM-17 loaded toolpath height consistency', () => {
  it.each<Operation['type']>([
    'face',
    'contour_2d',
    'pocket_2d',
    'adaptive_clearing_2d',
    'drill',
    'bore',
    'thread_mill',
    'engrave',
    'chamfer',
    'parallel_3d',
    'waterline_3d',
    'adaptive_3d',
  ])('keeps the current %s generator contract green with its clearance rapid', (type) => {
    const project = restampOperation(readyProject(), type)
    expect(operationGenerationIsCurrent(project, project.setups[0], loadedOperation(project)))
      .toBe(true)
    expect(reconcileProjectGenerationFreshness(project)).toBe(project)
  })

  it.each<Operation['type']>([
    'face',
    'contour_2d',
    'pocket_2d',
    'adaptive_clearing_2d',
    'drill',
    'bore',
    'thread_mill',
    'engrave',
    'chamfer',
  ])('keeps a compact truthful %s fixture without inventing a 3D clearance anchor', (type) => {
    const noClearanceMove = truthfulMoves.map((move) => ({
      ...move,
      z: Math.min(move.z, truthfulSnapshot.machine.retract),
    }))
    const project = restampOperation(readyProject(), type, noClearanceMove)
    expect(operationGenerationIsCurrent(project, project.setups[0], loadedOperation(project)))
      .toBe(true)
  })

  it('never treats an unwired future strategy as current: it has no V2 authority to be current under', () => {
    const noClearanceMove = truthfulMoves.map((move) => ({
      ...move,
      z: Math.min(move.z, truthfulSnapshot.machine.retract),
    }))
    const project = readyProject()
    const setup = project.setups[0]
    const operation = loadedOperation(project)
    expect(() => smartHeightAuthorityFixture(NEVER_WIRED_3D)).toThrow(/no live Smart Height V2 policy/)
    operation.type = NEVER_WIRED_3D
    operation.toolpathMoves = noClearanceMove
    operation.generationFingerprint = projectOperationFingerprint(
      project, setup, operation, operation.resolvedHeights!, tool,
    )
    expect(operationGenerationIsCurrent(project, setup, operation)).toBe(false)
    expect(loadedOperation(reconcileProjectGenerationFreshness(project)).status).toBe('outdated')
  })

  it('keeps truthful translated Adaptive actual-height paths green through resave and reload', () => {
    const firstLoad = JSON.parse(JSON.stringify(readyProject())) as Project
    const firstSetup = firstLoad.setups[0]
    const firstOperation = loadedOperation(firstLoad)
    expect(operationGenerationIsCurrent(firstLoad, firstSetup, firstOperation)).toBe(true)
    expect(reconcileProjectGenerationFreshness(firstLoad)).toBe(firstLoad)

    const resaved = JSON.parse(JSON.stringify(firstLoad)) as Project
    const secondLoad = reconcileProjectGenerationFreshness(resaved)
    expect(loadedOperation(secondLoad).status).toBe('ready')
    expect(loadedOperation(secondLoad).toolpathMoves).toEqual(truthfulMoves)
    expect(operationGenerationIsCurrent(
      secondLoad, secondLoad.setups[0], loadedOperation(secondLoad),
    )).toBe(true)
  })

  it('keeps a current empty result live for no-toolpath diagnostics but rejects it on reload', () => {
    const project = readyProject(truthfulSnapshot, [])
    const setup = project.setups[0]
    const operation = loadedOperation(project)

    expect(operationGenerationIsCurrent(project, setup, operation)).toBe(true)

    const reconciled = reconcileProjectGenerationFreshness(project)
    expect(loadedOperation(reconciled)).toMatchObject({
      status: 'outdated',
      toolpathMoves: undefined,
      generationFingerprint: undefined,
    })
  })

  it('downgrades a matching-fingerprint path whose saved moves stayed in geometry-local Z', () => {
    const localMoves = truthfulMoves.map((move) => ({
      ...move,
      z: move.z - GEOMETRY_POSITION_Z,
    }))
    // Moves are intentionally absent from the input fingerprint. CAM-17's
    // semantic freshness check must catch the frame mismatch itself.
    const project = readyProject(truthfulSnapshot, localMoves)
    expect(loadedOperation(project).generationFingerprint).toBe(
      readyProject().setups[0].operations[0].generationFingerprint,
    )
    expect(operationGenerationIsCurrent(project, project.setups[0], loadedOperation(project)))
      .toBe(false)

    const reconciled = reconcileProjectGenerationFreshness(project)
    expect(loadedOperation(reconciled)).toMatchObject({
      status: 'outdated',
      toolpathMoves: undefined,
      generationFingerprint: undefined,
    })
    expect(loadedOperation(reconciled).errorMessage).toContain('cannot be verified')
  })

  it('downgrades a self-consistent local snapshot that disagrees with the setup WCS frame', () => {
    const localSnapshot = {
      ...truthfulSnapshot,
      machine: Object.fromEntries(Object.entries(truthfulSnapshot.machine).map(
        ([name, value]) => [name, value - GEOMETRY_POSITION_Z],
      )),
    } as ResolvedHeightSnapshotV1
    const localMoves = truthfulMoves.map((move) => ({
      ...move,
      z: move.z - GEOMETRY_POSITION_Z,
    }))
    // Re-stamp the fingerprint over the wrong snapshot. A plain hash equality
    // therefore passes; only the machine-WCS frame invariant can reject it.
    const project = readyProject(localSnapshot, localMoves)
    expect(operationGenerationIsCurrent(project, project.setups[0], loadedOperation(project)))
      .toBe(false)
    expect(loadedOperation(reconcileProjectGenerationFreshness(project)).status).toBe('outdated')
  })

  it.each([
    {
      label: 'move above saved clearance',
      snapshot: truthfulSnapshot,
      moves: truthfulMoves.map((move, index) => index === 1 ? { ...move, z: 22.01 } : move),
    },
    {
      label: 'malformed legacy snapshot',
      snapshot: {
        ...truthfulSnapshot,
        machine: { ...truthfulSnapshot.machine, top: null },
      } as unknown as ResolvedHeightSnapshotV1,
      moves: truthfulMoves,
    },
    {
      label: 'unsafe saved plane ordering',
      snapshot: {
        ...truthfulSnapshot,
        machine: { ...truthfulSnapshot.machine, retract: 13 },
      } as ResolvedHeightSnapshotV1,
      moves: truthfulMoves,
    },
  ])('conservatively downgrades $label even when its saved fingerprint matches', ({ snapshot, moves }) => {
    const project = readyProject(snapshot, moves)
    expect(() => reconcileProjectGenerationFreshness(project)).not.toThrow()
    const reconciled = reconcileProjectGenerationFreshness(project)
    expect(loadedOperation(reconciled).status).toBe('outdated')
    expect(loadedOperation(reconciled).toolpathMoves).toBeUndefined()
  })
})
