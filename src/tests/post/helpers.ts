import type {
  FeedrateOverride,
  MachineConfig,
  Operation,
  Project,
  Setup,
  Stock,
  Tool,
  ToolpathMove,
  WCS,
} from '../../types'
import { projectOperationFingerprint } from '../../lib/cam/generationFingerprint'
import {
  envelopeFromResolvedWcsHeights,
  legacyHeightIntentForOperation,
  snapshotHeightEnvelope,
} from '../../lib/cam/heightIntent'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

export function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: 't1',
    name: 'Test Tool',
    type: 'flat_end_mill',
    diameter: 6,
    fluteLength: 25,
    shankDiameter: 6,
    overallLength: 60,
    numberOfFlutes: 3,
    material: 'carbide',
    coating: 'tialn',
    notes: '',
    toolNumber: 1,
    feedsAndSpeeds: {
      default: {
        rpm: 12000,
        feedRate: 2000,
        plungeRate: 400,
        depthOfCut: 2,
        stepover: 3,
        coolant: 'flood',
      },
    },
    ...overrides,
  }
}

export function makeMachine(overrides: Partial<MachineConfig> = {}): MachineConfig {
  return {
    id: 'm1',
    name: 'Test Machine',
    type: 'gantry_router',
    controller: 'uccnc',
    travel: { x: 600, y: 400, z: 100 },
    rapidRate: 5000,
    maxSpindleRpm: 24000,
    minSpindleRpm: 6000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: true,
    notes: '',
    ...overrides,
  }
}

export function makeOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op1',
    name: 'Op 1',
    type: 'contour_2d',
    enabled: true,
    status: 'ready',
    toolId: 't1',
    geometrySelections: [],
    heights: {
      clearanceHeight: 10,
      clearanceHeightMode: 'absolute',
      retractHeight: 5,
      feedHeight: 1,
      topHeight: 0,
      topHeightMode: 'stock_top',
      bottomHeight: -5,
      bottomHeightMode: 'absolute',
    },
    passes: {
      stepdown: 2,
      stepover: 3,
      stockToLeave: 0,
      finishPasses: 0,
      springPasses: 0,
    },
    linking: {
      entryType: 'plunge',
      rampAngle: 3,
      rampLength: 10,
      leadInRadius: 2,
      leadOutRadius: 2,
      retractType: 'full',
      transitionType: 'safe_height',
    },
    params: {},
    toolpathMoves: [move()],
    ...overrides,
  }
}

export function makeOverride(fields: Partial<FeedrateOverride> = {}): FeedrateOverride {
  return {
    enabled: true,
    rpm: 0,
    feedRate: 2000,
    plungeRate: 400,
    rampFeedrate: 600,
    leadInFeedrate: 1800,
    leadOutFeedrate: 1800,
    fastTraverseFeedrate: 3500,
    ...fields,
  }
}

export function makeWcs(overrides: Partial<WCS> = {}): WCS {
  return {
    id: 'w1',
    label: 'G54',
    fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
    ...overrides,
  }
}

export function move(overrides: Partial<ToolpathMove> = {}): ToolpathMove {
  return { type: 'feed', x: 0, y: 0, z: 0, role: 'cut', ...overrides }
}

/** Current-shaped setup stock (the stock model refactor removed 'auto'/'fixed'). */
export function makeStock(overrides: Partial<Stock> = {}): Stock {
  return {
    type: 'rectangular',
    width: 100,
    height: 80,
    depth: 20,
    offsetX: 0,
    offsetY: 0,
    offsetZTop: 0,
    offsetZBottom: 0,
    material: 'aluminum',
    ...overrides,
  }
}

/**
 * Stamp an operation as GENERATION-CURRENT (CAM-15, commit 52ac9e3e7): attach a
 * v1 resolved-height snapshot plus the matching input fingerprint, exactly like
 * the store does after a real regenerate. Without this, buildPostInput's
 * operationGenerationIsCurrent gate downgrades a 'ready' op to 'outdated'
 * (OP_OUTDATED) and posting refuses — the intended product behavior for ops
 * that were never regenerated against their current inputs.
 *
 * Pass the SAME project/setup/tool objects the test hands to the post path (for
 * store-driven tests: the merged `{ ...project, toolLibrary }` view) so the
 * fingerprint hashes identical inputs. Mutates `op` in place; safe to call
 * before the objects are placed in the store — the fingerprint hashes the op's
 * generation INPUTS, not the stamp fields themselves.
 */
export function stampGenerationCurrent(
  project: Project,
  setup: Setup,
  op: Operation,
  tool: Tool,
): void {
  const snapshot = snapshotHeightEnvelope(
    envelopeFromResolvedWcsHeights(op.heights, setup.wcs.origin.z),
    legacyHeightIntentForOperation(op),
  )
  // Smart Height V2 is the only authority (2e5678b7): a current op carries a
  // valid envelope and a resolved V2 plan alongside the V1 snapshot, or the
  // freshness gate refuses it. Stamp both before the fingerprint, which
  // hashes the envelope (ADR-0040: stamp the fixture, never migrate).
  op.smartHeight ??= smartHeightAuthorityFixture(op.type, { heights: op.heights })
  op.resolvedHeights = snapshot
  op.resolvedHeightPlan = smartHeightPlanFixture(op, snapshot)
  op.generationFingerprint = projectOperationFingerprint(project, setup, op, snapshot, tool)
}
