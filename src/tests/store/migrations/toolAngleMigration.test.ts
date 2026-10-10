// Tool-angle migration tests (ADR-0027 project chain, v1 -> v2).
//
// The v1->v2 step converts each tool's legacy, MIXED `tipAngle` field into the
// canonical `angleFromAxisDeg` (the from-axis half-angle):
//   angleFromAxisDeg = tipAngle >= 90 ? tipAngle / 2 : tipAngle
// because physical from-axis angles are always < 90 while old included
// drill-point defaults (118, etc.) are >= 90. The legacy `tipAngle` key is
// dropped. These tests drive the REAL migrateProjectData chain (not the helper
// in isolation) for the primary case, plus idempotency + untouched-tool guards.

import { describe, it, expect } from 'vitest'
import {
  migrateProjectData,
  migrateToolAngleFromAxis,
  CURRENT_PROJECT_SCHEMA_VERSION,
} from '../../../store/migrations/projectMigrations'

// Minimal valid-enough project carrying a tool library. Only the fields the
// migration touches matter; the hierarchy step tolerates the rest.
function makeProject(toolLibrary: any[], schemaVersion = 1): any {
  return {
    id: 'proj-tools',
    name: 'Tool Angle Project',
    version: '1.0.0',
    createdAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false,
      axisLimits: {
        x: { maxCutting: 3000, maxRapid: 5000 },
        y: { maxCutting: 3000, maxRapid: 5000 },
        z: { maxCutting: 1000, maxRapid: 3000 },
      },
      notes: '',
    },
    toolLibrary,
    geometry: [],
    setups: [],
    activeSetupId: null,
    activeOperationId: null,
    sceneStock: {
      mode: 'auto', autoOffsetXY: 5, autoOffsetZTop: 5,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 50, fixedStocks: [],
    },
    stocks: [],
    notes: '',
    schemaVersion,
  }
}

function makeTool(extra: Record<string, unknown>): any {
  return {
    id: 'tool-x', name: 'Tool', type: 'chamfer', diameter: 6,
    fluteLength: 10, shankDiameter: 6, overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none',
    notes: '', feedsAndSpeeds: {},
    ...extra,
  }
}

describe('tool tipAngle -> angleFromAxisDeg migration (v1 -> v2)', () => {
  it('converts mixed tipAngle values via the real migrateProjectData chain', () => {
    const project = makeProject([
      makeTool({ id: 't-45', tipAngle: 45 }),    // from-axis 45-deg chamfer -> 45
      makeTool({ id: 't-118', tipAngle: 118 }),  // 118 included drill default -> 59
      makeTool({ id: 't-22', tipAngle: 22.5 }),  // from-axis 22.5 -> 22.5
    ])

    const out = migrateProjectData(project)

    // migrateProjectData runs the FULL chain to current, not just v1->v2.
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)

    const tools = out.toolLibrary as any[]
    const byId = (id: string) => tools.find((t) => t.id === id)

    expect(byId('t-45').angleFromAxisDeg).toBe(45)
    expect(byId('t-118').angleFromAxisDeg).toBe(59)
    expect(byId('t-22').angleFromAxisDeg).toBe(22.5)

    // No `tipAngle` key survives on any tool.
    for (const t of tools) {
      expect('tipAngle' in t).toBe(false)
    }
  })

  it('is idempotent: a second pass is byte-identical (no tipAngle reintroduced)', () => {
    const once = migrateProjectData(
      makeProject([makeTool({ id: 't-118', tipAngle: 118 })]),
    )
    const twice = migrateProjectData(once)
    expect(twice).toEqual(once)
    expect('tipAngle' in (twice.toolLibrary as any[])[0]).toBe(false)

    // An already-v2 tool (canonical field, no legacy key) is untouched.
    const v2Project = makeProject(
      [makeTool({ id: 't-45', angleFromAxisDeg: 45 })],
      CURRENT_PROJECT_SCHEMA_VERSION,
    )
    const noop = migrateProjectData(v2Project)
    expect((noop.toolLibrary as any[])[0].angleFromAxisDeg).toBe(45)
    expect('tipAngle' in (noop.toolLibrary as any[])[0]).toBe(false)

    // Helper-level idempotency: running the step twice equals once.
    const stepOnce = migrateToolAngleFromAxis(
      makeProject([makeTool({ id: 't-118', tipAngle: 118 })]),
    )
    expect(migrateToolAngleFromAxis(stepOnce)).toEqual(stepOnce)
  })

  it('leaves a tool with no angle (flat end mill) untouched', () => {
    const flat = makeTool({ id: 't-flat', type: 'flat' })
    expect('tipAngle' in flat).toBe(false)
    expect('angleFromAxisDeg' in flat).toBe(false)

    const out = migrateProjectData(makeProject([flat]))
    const tool = (out.toolLibrary as any[])[0]
    expect('tipAngle' in tool).toBe(false)
    expect('angleFromAxisDeg' in tool).toBe(false)
    // Other fields intact.
    expect(tool.id).toBe('t-flat')
    expect(tool.diameter).toBe(6)
  })
})
