// WO-2899: alpha3 fixture data extends the existing registry, not a second runner.
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { starterCage, type StarterKind } from '../../form/starters'
import { buildFormBody, makeFormFeaturePayload } from '../../form/formBody'
import { GeomEngine } from '../../geom/worker/geom-engine'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'
import type { PartMesh } from '../../cam3d/kernel/types'
import { sanitizeTriangleMesh } from '../../cam3d/input/sanitize'
import type { Project, Tool, OperationType, Loop2D } from '../../types'
import type { BenchmarkChain, BenchmarkPart, BenchmarkStep, BenchmarkTool } from './registry'
import { CHAINS, TOOLS, WHOLE_PART } from './registry'
import { defaultParams } from './alpha3Defaults'
import { createToolInventory, createToolModel, type ToolDefinition } from '../../kernel/tools'
import { TOOL_TYPE_META } from '../../lib/tool/toolMeta'
import { buildToolProfile } from '../../lib/tool/toolProfile'
import { SIDE_ENTRY_ENGAGEMENT_CAP } from '../../cam3d/strategies/adaptiveRough'

// WO-2997: benchmark tools are read through the kernel tool inventory (WO-2932). The inventory
// sorts by physical key; the benchmark keeps its source order and explicit ids, so each record
// is matched back by exact content. A record the inventory altered or dropped throws.
const toolModel = createToolModel({ types: TOOL_TYPE_META, buildToolProfile })
export function inventoryTools(records: readonly Tool[]): Tool[] {
  const owned = createToolInventory(records, [], tool => toolModel.classify(tool).standardType).tools({ scope: 'owned' })
  const byId = new Map<string, ToolDefinition[]>()
  for (const { tool } of owned) byId.set(tool.id, [...(byId.get(tool.id) ?? []), tool as ToolDefinition])
  return records.map(record => {
    const pool = byId.get(record.id) ?? []
    const at = pool.findIndex(tool => isDeepStrictEqual(tool, record))
    if (at < 0) throw new Error(`tool inventory did not return benchmark tool "${record.id}" unchanged`)
    return structuredClone(pool.splice(at, 1)[0]) as Tool
  })
}

const EXAMPLES = [
  ['ex01-fixture-plate', 'examples/01-fixture-plate/fixture-plate.camproject'],
  ['ex02-toe-clamps', 'examples/02-toe-clamps/toe-clamps.camproject'],
  ['ex03-soft-jaws', 'examples/03-soft-jaws/soft-jaws.camproject'],
  ['ex04-tool-storage-bar', 'examples/04-tool-storage-bar/tool-storage-bar.camproject'],
  ['ex05-name-sign', 'examples/05-name-sign/name-sign.camproject'],
  ['ex06-knob-handwheel', 'examples/06-knob-handwheel/knob-handwheel.camproject'],
  ['ex07-relief-medallion', 'examples/07-relief-medallion/relief-medallion.camproject'],
  ['ex08-gear-pair', 'examples/08-gear-pair/gear-pair.camproject'],
] as const
let projects: { id: string; project: Project }[] | undefined
function exampleProjects() {
  return projects ??= EXAMPLES.map(([id, file]) => ({ id, project: JSON.parse(readFileSync(file, 'utf8')) as Project }))
}
let tools: BenchmarkTool[] | undefined
export function alpha3Tools(): BenchmarkTool[] {
  if (tools) return tools
  const library = JSON.parse(readFileSync('docs/machine/profiles/tool_library.json', 'utf8')) as Tool[]
  const threads = JSON.parse(readFileSync('examples/13-thread-mill-test/Thread Mill Tools - Metric Test Set.json', 'utf8')) as Tool[]
  const starter = JSON.parse(readFileSync('examples/tools/starter-tools-metric.json', 'utf8')) as Tool[]
  const actual = inventoryTools([...starter, ...library, ...threads, ...exampleProjects().flatMap(({ project }) => project.toolLibrary)])
  tools = [...new Map(actual.map(tool => [tool.id, {
    id: tool.id, label: tool.name, type: tool.type, diameter: tool.diameter,
    fluteLengthMm: tool.fluteLength ?? 0, cornerRadius: tool.cornerRadius,
    role: 'rough' as const, libraryTool: tool,
  }])).values()]
  // Original diameter/reach fixtures remain stable, with explicit library recipe provenance.
  // A recipe for a different diameter is NOT substituted into alpha3.
  for (const old of TOOLS) {
    const matched = actual.find(tool => tool.type === old.type && tool.diameter === old.diameter)
    if (matched) tools.push({ ...old, id: `a3-${old.id}`, libraryTool: { ...matched, id: `a3-${old.id}` } })
  }
  return tools
}
let parts: BenchmarkPart[] | undefined
export function alpha3Parts(): BenchmarkPart[] {
  return parts ??= (['box', 'cylinder', 'sphere', 'torus'] as StarterKind[]).map(kind => ({
    id: `form-${kind}`, label: `Form ${kind} starter`,
    stockMargin: { xy: 5, zTop: 5 }, coverageCell: 0.5,
    mesh: () => formMesh(kind),
  }))
}
const formMeshes = new Map<StarterKind, Promise<PartMesh>>()
function formMesh(kind: StarterKind): Promise<PartMesh> {
  let mesh = formMeshes.get(kind)
  if (!mesh) {
    mesh = (async () => {
      const engine = new GeomEngine()
      try {
        await engine.init()
        const result = await buildFormBody(engine, makeFormFeaturePayload(`Form ${kind}`, starterCage(kind)), `benchmark-${kind}`)
        if (!result.ok || !result.body) throw new Error(`Form ${kind} fixture failed: ${JSON.stringify(result.diagnostics)}`)
        const display = await engine.tessellate(result.body, DISPLAY_TESS_QUALITY)
        const positions = Float32Array.from(display.position)
        const clean = sanitizeTriangleMesh(positions, Uint32Array.from(display.index))
        return { positions: clean.positions, indices: clean.indices, bounds: clean.bounds, source: 'model' }
      } finally { await engine.disposeKernel() }
    })()
    formMeshes.set(kind, mesh)
  }
  return mesh
}
function paired(chain: BenchmarkChain): BenchmarkChain[] {
  return (['default', 'declared'] as const).map(mode => ({
    ...chain, id: `${chain.id}-${mode}`, setupLabel: `${chain.setupLabel}-${mode}`,
    tiers: ['alpha3'],
    steps: chain.steps.map(step => ({ ...step, parameterMode: mode,
      setupLabel: step.setupLabel ? `${step.setupLabel}-${mode}` : undefined,
      params: mode === 'default' ? defaultParams(step.type, step.params) : structuredClone(step.params),
      stockToLeaveMm: mode === 'default' ? 0 : step.stockToLeaveMm,
    })),
  }))
}
// WO-3025: both adaptive engines promise the same ceiling, 0.75 of a full slot: the 3D
// strategy exports it (adaptiveRough.ts SIDE_ENTRY_ENGAGEMENT_CAP) and the 2D engine
// writes it as `0.75 * (2 * toolRadius)` at every load gate (processFeature.ts). The stick
// reads the exported one so it moves with the engine.
const isAdaptive = (type: OperationType) => type === 'adaptive_clearing_2d' || type === 'adaptive_3d'
function fixtureStep(type: OperationType, toolId: string): BenchmarkStep {
  return { id: type, type, toolId, scope: WHOLE_PART, params: defaultParams(type, {}),
    stockToLeaveMm: 0, gougeToleranceMm: 0.4, lateralAllowanceMm: 0.2,
    ...(isAdaptive(type) ? { engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP } : {}) }
}
let chains: BenchmarkChain[] | undefined
export function alpha3Chains(): BenchmarkChain[] {
  if (chains) return chains
  const library = alpha3Tools()
  const flat = library.find(tool => tool.type === 'flat_end_mill' && tool.diameter === 6 && tool.libraryTool?.feedsAndSpeeds.default?.feedRate === 800)
    ?? library.find(tool => tool.type === 'flat_end_mill' && tool.diameter === 6)!
  const flat4 = TOOLS.find(tool => tool.id === 'bm-flat-4')!
  // WO-3025: bm-flat-4 has no library recipe, so every adaptive row on it was n/a. The
  // adaptive second tool is the real 3 mm starter flat (examples/tools/starter-tools-metric.json).
  const flat3 = library.find(tool => tool.type === 'flat_end_mill' && tool.diameter === 3 && tool.libraryTool?.feedsAndSpeeds.default?.feedRate === 450)!
  const ball3 = library.find(tool => tool.type === 'ball_end_mill' && tool.diameter === 3)!
  const ball2 = TOOLS.find(tool => tool.id === 'bm-ball-2')!
  const oneFlute = library.find(tool => tool.type === 'flat_end_mill' && tool.diameter === 3.1)!
  const drill4 = library.find(tool => tool.type === 'drill' && tool.diameter === 4)!
  const threadIds = (JSON.parse(readFileSync('examples/13-thread-mill-test/Thread Mill Tools - Metric Test Set.json', 'utf8')) as Tool[]).map(tool => tool.id)
  const variants = (step: BenchmarkStep): BenchmarkStep[] => {
    const ids = ({ face: [flat.id], pocket_2d: [flat.id, flat4.id],
      adaptive_clearing_2d: [flat.id, flat3.id], contour_2d: [flat.id, oneFlute.id],
      drill: [drill4.id], thread_mill: threadIds, bore: [flat.id, flat4.id], adaptive_3d: [flat.id, flat3.id],
      parallel_3d: [ball3.id], waterline_3d: [ball3.id, flat.id],
      scallop_3d: [ball3.id, ball2.id], steep_shallow_3d: [ball3.id],
    } as Partial<Record<OperationType, string[]>>)[step.type] ?? [step.toolId]
    // A second tool runs AFTER the first in the same setup (a rest pass for 3D adaptive), but
    // measureRadialEngagement replays from the uncut box, so only the first carries the cap.
    return ids.map((id, index) => ({ ...step, unavailableReason: undefined, id: index ? `${step.id}-tool${index + 1}` : step.id, toolId: id,
      ...(index ? { engagementCapFraction: undefined } : {}),
      ...(!library.find(tool => tool.id === id)?.libraryTool ? {
        unavailableReason: `n/a: no real library recipe for ${id}; synthetic diameter-derived feeds are excluded from alpha3`,
      } : {}),
    }))
  }
  const result: BenchmarkChain[] = []
  for (const original of CHAINS) {
    const steps = original.steps.flatMap(step => {
      const matched = library.find(tool => tool.id === `a3-${step.toolId}`)
      return variants({ ...step, toolId: matched?.id ?? step.toolId,
        ...(!matched ? { unavailableReason: `n/a: no real library recipe for ${step.toolId}; synthetic diameter-derived feeds are excluded from alpha3` } : {}),
      })
    })
    result.push(...paired({ ...original, steps, alpha3: { material: 'aluminum' } }))
  }
  for (const part of alpha3Parts()) {
    result.push(...paired({ id: part.id, partId: part.id, setupLabel: 'top', tiers: ['alpha3'],
      alpha3: { material: 'aluminum' }, steps: variants(fixtureStep('adaptive_3d', flat.id)) }))
  }
  // Step-5 spike chains: acquisition is the same production function for all three.
  for (const [type, ids] of [
    ['waterline_3d', ['boss-taper-step', 'stepped-boss']],
    ['scallop_3d', ['feature-block-mesh', 'boss-taper-step']],
    ['steep_shallow_3d', ['boss-taper-step', 'feature-block-mesh']],
  ] as const) {
    for (const partId of ids) result.push(...paired({ id: `${partId}-${type}`, partId,
      setupLabel: type, tiers: ['alpha3'], alpha3: { material: 'aluminum' },
      steps: variants(fixtureStep(type, type === 'waterline_3d' ? flat.id : ball3.id)),
    }))
  }
  for (const { id, project } of exampleProjects()) {
    const sourceSteps = project.setups.flatMap((setup, setupIndex) => setup.operations.map((op, index): BenchmarkStep => ({
      id: `setup${setupIndex + 1}-step${index + 1}-${op.type}`, type: op.type, toolId: op.toolId ?? '',
      setupLabel: `setup${setupIndex + 1}`, authoredSetupId: setup.id, scope: WHOLE_PART, params: structuredClone(op.params),
      geometrySelections: op.geometrySelections, authoredOperation: op,
      stockToLeaveMm: op.passes.stockToLeave, gougeToleranceMm: 0.4, lateralAllowanceMm: 0.2,
      // Only the project's first operation cuts the uncut box the engagement replay starts from.
      ...(isAdaptive(op.type) && setupIndex === 0 && index === 0 ? { engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP } : {}),
    })))
    // The study explicitly adds trace of the sign's existing text outlines.
    if (id === 'ex05-name-sign') {
      const carve = sourceSteps.find(step => step.type === 'vcarve')!
      sourceSteps.push({ ...carve, id: 'text-outline-engrave', type: 'engrave',
        params: { ...defaultParams('engrave', carve.params) },
        authoredOperation: { ...carve.authoredOperation!, type: 'engrave', smartHeight: undefined },
      })
    }
    result.push(...paired({ id, partId: id, setupLabel: 'top', tiers: ['alpha3'], steps: sourceSteps.flatMap(variants),
      alpha3: { material: project.setups[0]?.stock.material ?? '', project },
    }))
  }
  // Exact H-pocket footprint from cam3d/fixtures/index.ts, not a replacement part.
  const outlines = [
    [[10,10],[40,10],[40,27],[50,27],[50,10],[80,10],[80,50],[50,50],[50,33],[40,33],[40,50],[10,50]],
    [[20,25],[20,35],[30,35],[30,25]],
  ]
  const planarPicks: Loop2D[] = outlines.map((points, index) => ({
    id: `geo-engagement-pocket~${index ? 'island' : 'pocket'}`,
    // WO-3025: the island is typed the way the app's importers type a nested loop
    // (path2d.ts classifyClosedLoopsByContainment: odd depth = 'hole'). As 'contour' both
    // engines machined it away as a second pocket.
    points: points.map(([x,y]) => ({ x, y })), closed: true, type: index ? 'hole' : 'contour', layerId: 'benchmark',
    area: index ? 100 : 2460,
  }))
  for (const type of ['pocket_2d', 'adaptive_clearing_2d'] as const) {
    result.push(...paired({ id: `engagement-pocket-${type}`, partId: 'engagement-pocket',
      setupLabel: type, tiers: ['alpha3'], alpha3: { material: 'aluminum', planarPicks },
      steps: variants({ ...fixtureStep(type, flat.id), geometrySelections: planarPicks.map(loop => loop.id),
        params: { ...defaultParams(type, {}), geometryId: 'geo-engagement-pocket',
          loopIds: planarPicks.map(loop => loop.id), planeOffset: -12 },
      }),
    }))
  }
  // Geometry-only inputs: explicit unresolved picks, never invented holes/faces.
  for (const [partId, type, reason] of [
    ['ex12-tray', 'adaptive_clearing_2d', 'pick unresolved: examples/12-tray ships Tray.step and no project, so no operation names a pocket floor or loop; the stick has no face/loop recognition route that turns a STEP face into a planar pick, and it does not invent one'],
    ['ex13-thread-mill-test', 'thread_mill', 'pick unresolved: geometry-only STEP has no authored circle/boss selection; recognition fixture owed'],
  ] as const) result.push(...paired({ id: `${partId}-${type}-unresolved`, partId,
    setupLabel: `${partId}-${type}`, tiers: ['alpha3'], alpha3: { material: 'aluminum' },
    steps: (type === 'thread_mill' ? threadIds : [flat.id, flat3.id]).map((toolId, index) => ({ ...fixtureStep(type, toolId), id: `${type}-tool${index + 1}`, scope: { id: partId, label: partId }, unavailableReason: `n/a: ${reason}` })),
  }))
  chains = result
  return chains
}
