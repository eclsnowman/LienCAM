// SKC-47-R2 — derive the closed-loop-consumer census MECHANICALLY from source.
//
// DECISIONS 2026-07-15 STOP ruling: two rounds asserted "every closed-loop-consuming CAM
// operation refuses by name" from prose memory; the consumer set was never derived, and Face
// 2D / Adaptive Clearing kept silent zero-move paths. This file is the derivation, not a
// hand-authored list:
//   1. Parses src/lib/cam/types.ts (TS AST) for every exported interface with a
//      `loops: LoopData[]` member, and for the WorkerRequestMsg union's
//      `{ type: 'X'; payload: Y }` mapping.
//   2. Parses src/lib/cam/toolpathWorker.ts (TS AST) for every routed request type and the
//      builder/runNest call that serves it — the TOOLPATH_BUILDERS table's rows (WO-1819
//      replaced the eleven-arm if/else chain with that lookup) AND any remaining
//      `msg.type === 'X'` branch, which is how COMPUTE_NEST is still handled (it produces
//      placements, not moves, so it has no row in the toolpath table).
//   3. Computes the DERIVED consumer set = every msgType toolpathWorker.ts actually routes to a
//      builder, each tagged with whether its payload carries `loops: LoopData[]` (rule a+b) or
//      not (rule c — the explicit COMPUTE_NEST carve-out; nest resolves loops at the STORE
//      boundary, see the citation in TABLE below).
//   4. Asserts TWO-WAY equality against the committed TABLE: a derived consumer missing a row
//      is RED naming it; a TABLE row with no derived consumer is RED (stale row). This is NOT a
//      table the test merely reads — rename a payload field, delete a routing branch, or add a
//      new COMPUTE_* type in EITHER source file and the derivation itself changes, so the
//      equality check goes RED without anyone touching this file.
//   5. Drives every 'refusal' row's builder directly with the canonical partial-ellipse bake
//      fixture (SKC-47-R1: an elliptical arc + a chord bakes to TWO disconnected OPEN loops,
//      never one closed region) and asserts a thrown Error naming the reason.
//   6. Proves the one 'proven-safe' builder row (engrave) is NOT overreached into a refusal on
//      the same fixture — open loops are a supported input BY DESIGN there.
import { describe, it, expect, beforeAll } from 'vitest'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { bakeSketch } from '../../lib/sketch/bake'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'

import { buildContourToolpath } from '../../lib/cam/contour2d'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { buildDrillToolpath } from '../../lib/cam/drill2d'
import { buildBoreToolpath } from '../../lib/cam/bore2d'
import { buildThreadMillToolpath } from '../../lib/cam/threadmill2d'
import { buildChamferToolpath } from '../../lib/cam/chamfer2d'
import { buildFaceToolpath } from '../../lib/cam/face2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { buildEngraveToolpath } from '../../lib/cam/engrave2d'
import { buildAdaptiveClearingToolpath } from '../../lib/cam/adaptiveClearing2d/engine'
import { ensureEngineClipperReady } from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import type {
  ContourParams, ContourWorkerPayload, PocketParams, PocketWorkerPayload,
  DrillParams, DrillWorkerPayload, BoreParams, BoreWorkerPayload,
  ThreadMillParams, ThreadMillWorkerPayload,
  ChamferParams, ChamferWorkerPayload, FaceParams, FaceWorkerPayload,
  EngraveParams, EngraveWorkerPayload, ACParams, ACWorkerPayload, LoopData,
} from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

await ensureClipperReady()

// ── Step 1+2: parse the two source files that define + route the worker payloads ──────────
const CAM_SRC = join(process.cwd(), 'src', 'lib', 'cam')
const TYPES_SRC = readFileSync(join(CAM_SRC, 'types.ts'), 'utf8')
const WORKER_SRC = readFileSync(join(CAM_SRC, 'toolpathWorker.ts'), 'utf8')

function interfacesWithLoopDataLoops(source: string): Set<string> {
  const sf = ts.createSourceFile('types.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const hits = new Set<string>()
  const isLoopDataArray = (t: ts.TypeNode | undefined): boolean =>
    !!t && ts.isArrayTypeNode(t) && ts.isTypeReferenceNode(t.elementType) &&
    ts.isIdentifier(t.elementType.typeName) && t.elementType.typeName.text === 'LoopData'
  sf.forEachChild(node => {
    if (ts.isInterfaceDeclaration(node)) {
      const hasLoops = node.members.some(m =>
        ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name) &&
        m.name.text === 'loops' && isLoopDataArray(m.type))
      if (hasLoops) hits.add(node.name.text)
    }
  })
  return hits
}

function workerRequestMsgMapping(source: string): Array<{ msgType: string; payloadInterface: string }> {
  const sf = ts.createSourceFile('types.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: Array<{ msgType: string; payloadInterface: string }> = []
  sf.forEachChild(node => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'WorkerRequestMsg' && ts.isUnionTypeNode(node.type)) {
      for (const member of node.type.types) {
        if (!ts.isTypeLiteralNode(member)) continue
        let msgType: string | undefined
        let payloadInterface: string | undefined
        for (const m of member.members) {
          if (!ts.isPropertySignature(m) || !m.name || !ts.isIdentifier(m.name) || !m.type) continue
          if (m.name.text === 'type' && ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal)) {
            msgType = m.type.literal.text
          }
          if (m.name.text === 'payload' && ts.isTypeReferenceNode(m.type) && ts.isIdentifier(m.type.typeName)) {
            payloadInterface = m.type.typeName.text
          }
        }
        if (msgType && payloadInterface) out.push({ msgType, payloadInterface })
      }
    }
  })
  return out
}

// Every request type toolpathWorker.ts routes -> the build<Name>Toolpath / runNest call that
// serves it. Two forms, both derived from the AST, never from a list:
//   - a TOOLPATH_BUILDERS row (`COMPUTE_X: (payload, onProgress) => buildXToolpath(...)`) —
//     the WO-1819 dispatch table that replaced the if/else chain;
//   - an `if (msg.type === 'X')` branch — still how COMPUTE_NEST is handled.
function workerRouting(source: string): Map<string, string> {
  const sf = ts.createSourceFile('toolpathWorker.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const routing = new Map<string, string>()

  const msgTypeOf = (cond: ts.Expression): string | undefined => {
    if (!ts.isBinaryExpression(cond) || cond.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return undefined
    const lit = ts.isStringLiteral(cond.right) ? cond.right : ts.isStringLiteral(cond.left) ? cond.left : undefined
    return lit?.text
  }

  const findBuilderCall = (node: ts.Node): string | undefined => {
    let found: string | undefined
    const visit = (n: ts.Node) => {
      if (found) return
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) &&
          (/^build\w+Toolpath$/.test(n.expression.text) || n.expression.text === 'runNest')) {
        found = n.expression.text
        return
      }
      n.forEachChild(visit)
    }
    visit(node)
    return found
  }

  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node)) {
      const msgType = msgTypeOf(node.expression)
      if (msgType) {
        const builder = findBuilderCall(node.thenStatement)
        if (builder) routing.set(msgType, builder)
      }
    }
    // The dispatch TABLE: each property name is a request type, each initializer
    // reaches exactly one builder. Derived the same way the branches are, so a
    // deleted row or a re-pointed builder changes the census on its own.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === 'TOOLPATH_BUILDERS') {
      const table = node.initializer && ts.isSatisfiesExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer
      if (table && ts.isObjectLiteralExpression(table)) {
        for (const prop of table.properties) {
          if (!ts.isPropertyAssignment(prop)) continue
          const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined
          if (!key) continue
          const builder = findBuilderCall(prop.initializer)
          if (builder) routing.set(key, builder)
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return routing
}

const loopDataInterfaces = interfacesWithLoopDataLoops(TYPES_SRC)
const msgMapping = workerRequestMsgMapping(TYPES_SRC)
const routing = workerRouting(WORKER_SRC)

// ── Step 3: the derived consumer set ───────────────────────────────────────────────────────
type DerivedConsumer = { msgType: string; builder: string; payloadInterface: string | undefined; carriesLoopData: boolean }
const derived: DerivedConsumer[] = [...routing.entries()].map(([msgType, builder]) => {
  const mapped = msgMapping.find(m => m.msgType === msgType)
  const payloadInterface = mapped?.payloadInterface
  return { msgType, builder, payloadInterface, carriesLoopData: !!payloadInterface && loopDataInterfaces.has(payloadInterface) }
})

// ── Step 4: the committed classification table ─────────────────────────────────────────────
// Each row's `builder` must equal what workerRouting() derives from toolpathWorker.ts, or the
// equality test below goes RED. 'refusal' rows carry the regex the behavioral test (Step 5)
// asserts against; 'proven-safe' rows carry ONLY a citation — no separate refusal is warranted.
const TABLE: Record<string, {
  builder: string
  behavior: 'refusal' | 'proven-safe'
  citation: string
  refusalPattern?: RegExp
}> = {
  COMPUTE_CONTOUR: {
    builder: 'buildContourToolpath', behavior: 'refusal',
    citation: 'contour2d.ts:85 — ALREADY throws; frozen verbatim (loop-selection-failloud.test.ts pins it).',
    refusalPattern: /Contour:.*no closed loop/i,
  },
  COMPUTE_POCKET: {
    builder: 'buildPocketToolpath', behavior: 'refusal',
    citation: 'pocket2d.ts:1143/:1148 — ALREADY throws; frozen verbatim (loop-selection-failloud.test.ts pins it).',
    refusalPattern: /Pocket:.*no closed loop/i,
  },
  COMPUTE_DRILL: {
    builder: 'buildDrillToolpath', behavior: 'refusal',
    citation: 'drill2d.ts — SKC-47-R2 fix: filters by loopIds THEN closed (was loopIds-only, so an ' +
      'open loop selected as a hole produced moves at the open arc centroid — silent wrong geometry, ' +
      'worse than empty). The pre-existing zero-loop message (drill2d.ts:116) is frozen verbatim.',
    refusalPattern: /Drill:.*(no hole loop found|open loops)/i,
  },
  COMPUTE_BORE: {
    builder: 'buildBoreToolpath', behavior: 'refusal',
    citation: 'bore2d.ts:258-265 — ALREADY throws by name on both empty-match paths: an orphaned ' +
      'selection (ids that no longer exist after a geometry re-derive) and a no-circular-loop ' +
      'geometry. A non-circle explicitly selected by id is refused downstream by the circle fit ' +
      '(bore2d.ts:81/:109, "not a sampled circle" / "not round enough").',
    refusalPattern: /Bore:.*(no circular bore loop|no longer exist)/i,
  },
  COMPUTE_THREAD_MILL: {
    builder: 'buildThreadMillToolpath', behavior: 'refusal',
    citation: 'threadmill2d.ts — SKC-47-R2 fix, same shape as drill (was loopIds-only, no closed check). ' +
      'The pre-existing zero-loop message (threadmill2d.ts:93) is frozen verbatim.',
    refusalPattern: /Thread mill:.*(no hole loop found|open loops)/i,
  },
  COMPUTE_CHAMFER: {
    builder: 'buildChamferToolpath', behavior: 'refusal',
    citation: 'chamfer2d.ts:123 — ALREADY throws; frozen verbatim.',
    refusalPattern: /Chamfer:.*no closed loop/i,
  },
  COMPUTE_FACE: {
    builder: 'buildFaceToolpath', behavior: 'refusal',
    citation: 'face2d/index.ts — SKC-47-R2 fix (was `return moves` silently). TWO-LAYER story: the ' +
      'geometry-boundary UI path is ALREADY refused loudly pre-dispatch at store/index.ts:5415-5420 ' +
      '(both R1/R2 audits probed buildFaceToolpath directly, bypassing that guard); this builder-boundary ' +
      'throw is defense-in-depth (ADR-0003) for any caller that reaches the builder without going through ' +
      'the store (a hand-edited project, a future caller, or the stock-boundary synthesize-rectangle path ' +
      'degenerating).',
    refusalPattern: /Face:.*no closed loop/i,
  },
  COMPUTE_ENGRAVE: {
    builder: 'buildEngraveToolpath', behavior: 'proven-safe',
    citation: 'engrave2d/index.ts:117-121 — open loops are a SUPPORTED input BY DESIGN (includeOpen): a ' +
      'baked partial-ellipse open polyline is a valid engrave/trace target, not a refusal target. The ' +
      'pre-existing sub-2-point-curve empty-green (engrave2d.test.ts:174) is a separate, legitimate, ' +
      'out-of-scope skip.',
  },
  COMPUTE_VCARVE: {
    builder: 'buildVCarveToolpath', behavior: 'refusal',
    citation: 'vcarve2d/index.ts — WO-1174: closed loops only; an open-only or empty selection throws ' +
      '"V-carve: no closed outline selected" by name (vcarve2d.test.ts pins it). Open curves cannot be ' +
      'V-carved: the bit rides the medial axis of a REGION, which an open curve does not enclose.',
    refusalPattern: /V-carve:.*no closed outline/i,
  },
  COMPUTE_ADAPTIVE_CLEARING: {
    builder: 'buildAdaptiveClearingToolpath', behavior: 'refusal',
    citation: 'adaptiveClearing2d/engine/index.ts — SKC-47-R2 fix (was console.warn + `return []`, ' +
      'genuinely silent END-TO-END: unlike Face/Pocket, the store has NO pre-dispatch guard for AC\'s ' +
      '"geometry" boundary branch — this was the live user-facing defect the R1 audit named).',
    refusalPattern: /Adaptive Clearing:.*no closed loop/i,
  },
  COMPUTE_NEST: {
    builder: 'runNest', behavior: 'proven-safe',
    citation: 'Rule (c) explicit row — NestWorkerPayload carries pre-resolved NestPart, not ' +
      '`loops: LoopData[]`; nest consumes baked closed loops at the STORE boundary instead ' +
      '(store/index.ts:2739, outer = largest closed loop) and a no-closed-loop source is visibly ' +
      'SKIPPED with a console event naming it (store/index.ts:7762-7765) — proven-safe, not a builder refusal.',
  },
}

// ── Named exclusions (SKC-47-R3) ───────────────────────────────────────────────────────────
// The census above is DERIVED from toolpathWorker.ts's routing table, so it structurally can
// only ever see consumers that route through that worker. Three OTHER Loop2D/LoopData consumers
// exist in the codebase and were never named here — the R2 audit flagged that omission as a gap
// in the binding contract, not a gap in the derivation itself (each is outside the worker's
// routing table by construction, so the AST walk in Step 1+2 above cannot and should not find
// them). This table names all three and cites why each is out of scope for the CAM
// toolpath-consumer set the derivation above audits.
const EXCLUSIONS: Array<{ consumer: string; file: string; symbol: string; reason: string }> = [
  {
    consumer: 'dispatchGeo rendering',
    file: 'src/store/dispatchGeo.ts',
    symbol: 'geometryWorldBounds',
    reason: 'Computes an AABB over geo.loops (line 375-376) to size the AUTO stock box for ' +
      'display — it never checks loop.closed at all (open and closed loops both contribute ' +
      'equally) and never routes through toolpathWorker.ts, so it is structurally incapable of ' +
      'needing the closed-loop refusal behavior this census audits.',
  },
  {
    consumer: 'Part-Studio sketchProfile',
    file: 'src/components/model3d/workbench/sketchProfile.ts',
    symbol: 'extractSketchProfile',
    reason: 'A DIFFERENT feature domain: builds a 3D solid feature (OCCT makeExtrude/' +
      'makeRevolve) for the Part-Studio workbench, not a 2D CAM toolpath, and never routes ' +
      'through toolpathWorker.ts. It refuses open/degenerate sketches by name via its own ' +
      'SketchProfileRefusalCode mechanism (e.g. \'open-loop\'), separately covered by ' +
      'src/tests/model3d/sketchProfile.test.ts — a parallel, not a gap in, this census.',
  },
  {
    consumer: 'nest-expansion display',
    file: 'src/lib/viewport/restoreScene.ts',
    symbol: 'restoreNestsToViewport',
    reason: 'Pure scene rendering: expands a computed NestRecord\'s placements back to THREE.js ' +
      'Line objects for the viewport (via resolveNestSourceLoops in src/lib/viewport/' +
      'nestSources.ts, which itself filters to closed loops for renderability). It produces no ' +
      'toolpath moves and never routes through toolpathWorker.ts — distinct from the COMPUTE_NEST ' +
      'row above, which IS a worker-routed toolpath consumer (runNest) that resolves loops at the ' +
      'store boundary before dispatch.',
  },
]

describe('Loop-consumer census — named exclusions (SKC-47-R3)', () => {
  it('every named exclusion cites a symbol that still exists in the cited file (a stale citation is RED)', () => {
    for (const ex of EXCLUSIONS) {
      const src = readFileSync(join(process.cwd(), ex.file), 'utf8')
      expect(src.includes(ex.symbol), `${ex.consumer}: "${ex.symbol}" no longer found in ${ex.file}`).toBe(true)
    }
  })

  it('no named exclusion is actually routed by toolpathWorker.ts (it would belong in TABLE, not here)', () => {
    const routedFiles = new Set(derived.map(d => d.builder))
    for (const ex of EXCLUSIONS) {
      expect(routedFiles.has(ex.symbol), `${ex.consumer}'s "${ex.symbol}" IS worker-routed — move it into TABLE, not EXCLUSIONS`).toBe(false)
    }
  })
})

describe('Loop-consumer census (SKC-47-R2) — derived mechanically from source', () => {
  it('every DERIVED consumer has a table row (an unclassified new COMPUTE_* type is RED)', () => {
    const missing = derived.filter(d => !TABLE[d.msgType]).map(d => d.msgType)
    expect(missing, `unclassified consumer(s), name them in TABLE: ${missing.join(', ')}`).toEqual([])
  })

  it('every TABLE row still has a derived consumer (a stale row with no live routing is RED)', () => {
    const derivedTypes = new Set(derived.map(d => d.msgType))
    const stale = Object.keys(TABLE).filter(t => !derivedTypes.has(t))
    expect(stale, `stale table row(s), no derived consumer routes to them: ${stale.join(', ')}`).toEqual([])
  })

  it('every derived consumer routes to the builder its table row names', () => {
    for (const d of derived) {
      const row = TABLE[d.msgType]
      expect(row, `${d.msgType} has no table row`).toBeDefined()
      expect(row.builder, `${d.msgType} derived-routes to ${d.builder}, but TABLE says ${row.builder}`).toBe(d.builder)
    }
  })

  it('COMPUTE_NEST is the one rule-(c) explicit row: it does NOT carry loops: LoopData[]', () => {
    const nest = derived.find(d => d.msgType === 'COMPUTE_NEST')
    expect(nest, 'COMPUTE_NEST must be routed by toolpathWorker.ts').toBeDefined()
    expect(nest!.carriesLoopData).toBe(false)
  })

  it('every OTHER derived consumer DOES carry loops: LoopData[] (rule a+b)', () => {
    for (const d of derived) {
      if (d.msgType === 'COMPUTE_NEST') continue
      expect(d.carriesLoopData, `${d.msgType} payload (${d.payloadInterface}) is missing loops: LoopData[]`).toBe(true)
    }
  })

  it('non-vacuity: the derived set has exactly the 10 known consumers today (documents scope; a ' +
     'change here is expected to accompany a TABLE edit, not silently pass)', () => {
    expect(derived.map(d => d.msgType).sort()).toEqual(Object.keys(TABLE).sort())
  })
})

// ── Step 5+6 fixtures: a genuinely-open partial-ellipse bake (SKC-48) ───────────────────────
// SKC-48 taught bake.ts to CHAIN a partial ellipse with its adjacent chord into ONE closed loop
// (Part-Studio parity), so the old arc+chord drive fixture no longer bakes open — it now closes.
// The refusal rows must still be driven with a genuinely OPEN bake, so the canonical Step-5/6 drive
// fixture is a LONE elliptical arc (no closing neighbour): it still bakes to exactly ONE open loop
// (a lone arc has nothing to chain to — chaining fabricates no closure), which is the honest
// no-closed-loop input every refusal-classified consumer must fail loud on. The arc+chord D-shape
// is retained below as a SECOND fixture, now asserted to bake to ONE CLOSED loop and driven into two
// real builders to prove the SKC-48 chaining actually produces cuttable geometry.
function sketch(entities: SketchEntity[]): Sketch {
  return { id: 'S1', layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null }
}
const line = (id: string, ax: number, ay: number, bx: number, by: number): SketchEntity => ({
  id, kind: 'line', construction: false, start: { x: ax, y: ay }, end: { x: bx, y: by },
})
const ellipticalArc = (id: string, majorRadius: number, minorRadius: number, startParam: number, endParam: number): SketchEntity => ({
  id, kind: 'elliptical-arc', construction: false,
  center: { x: 0, y: 0 }, majorRadius, minorRadius, rotation: 0, startParam, endParam,
})
function ellipsePt(a: number, b: number, t: number): { x: number; y: number } {
  return { x: a * Math.cos(t), y: b * Math.sin(t) }
}
const A = 20, B = 10
const START = ellipsePt(A, B, 0)
const END = ellipsePt(A, B, Math.PI)
// DRIVE fixture: a LONE elliptical arc -> exactly ONE open loop (163 tessellation points).
const PARTIAL_ELLIPSE_LOOPS: LoopData[] = bakeSketch(sketch([
  ellipticalArc('ea', A, B, 0, Math.PI),
])).loops as unknown as LoopData[]
// SECOND fixture: the arc + chord D-shape -> exactly ONE closed loop after the SKC-48 chaining fix.
const DSHAPE_LOOPS: LoopData[] = bakeSketch(sketch([
  ellipticalArc('ea', A, B, 0, Math.PI),
  line('chord', END.x, END.y, START.x, START.y),
])).loops as unknown as LoopData[]

describe('Loop-consumer census — fixture non-vacuity', () => {
  it('the lone-elliptical-arc drive fixture bakes to exactly ONE open loop, never a closed region', () => {
    expect(PARTIAL_ELLIPSE_LOOPS).toHaveLength(1)
    expect(PARTIAL_ELLIPSE_LOOPS.every(l => l.closed === false)).toBe(true)
    // one 163-point tessellated arc — the SKC-48 canonical open-loop pin (was [2,163] arc+chord).
    expect(PARTIAL_ELLIPSE_LOOPS.map(l => l.points.length)).toEqual([163])
  })

  it('the arc+chord D-shape now bakes to exactly ONE CLOSED loop (SKC-48 chaining), a cuttable region', () => {
    expect(DSHAPE_LOOPS).toHaveLength(1)
    expect(DSHAPE_LOOPS[0].closed).toBe(true)
  })
})

// ── Shared minimal fixtures (heights/passes/linking/tool) ──────────────────────────────────
const TOOL: Tool = {
  id: 't1', name: 'O6 flat', type: 'flat_end_mill',
  diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 50,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 2 } },
} as Tool
const CHAMFER_TOOL: Tool = { ...TOOL, angleFromAxisDeg: 45 } as Tool
const HEIGHTS: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function contourPayload(loops: LoopData[]): ContourWorkerPayload {
  return {
    opId: 'op', setupId: 's',
    params: { geometryId: 'g', loopIds: [], side: 'outer', direction: 'climb', tabs: false } as ContourParams,
    heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: TOOL, loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function pocketPayload(loops: LoopData[]): PocketWorkerPayload {
  return {
    opId: 'op', setupId: 's',
    params: {
      geometryId: 'g', loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
      fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
      helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
    } as PocketParams,
    heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: TOOL, loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function drillPayload(loops: LoopData[]): DrillWorkerPayload {
  return {
    opId: 'op', setupId: 's',
    params: {
      geometryId: 'g', loopIds: [], cycleType: 'simple', peckDepth: 3, chipBreakRetract: 1,
      dwell: 0, retractMode: 'clearance', sortStrategy: 'none',
    } as DrillParams,
    heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: TOOL, loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function borePayload(loops: LoopData[]): BoreWorkerPayload {
  return {
    opId: 'op', setupId: 's',
    params: {
      geometryId: 'g', loopIds: [], direction: 'climb', sortStrategy: 'none',
    } as BoreParams,
    heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: TOOL, loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function threadMillPayload(loops: LoopData[]): ThreadMillWorkerPayload {
  return {
    opId: 'op', setupId: 's',
    params: {
      geometryId: 'g', loopIds: [], threadKind: 'internal', majorDiameter: 10, pitch: 1.5,
      handedness: 'right', cutDirection: 'climb', roughingPasses: 1, springPasses: 0,
      leadInOut: 'arc', compensation: 'computer',
    } as ThreadMillParams,
    heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: TOOL, loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function chamferPayload(loops: LoopData[]): ChamferWorkerPayload {
  return {
    opId: 'op', setupId: 's',
    params: {
      geometryId: 'g', loopIds: [], loopSides: {}, direction: 'climb',
      chamferWidth: 1, tipOffset: 0, overlapMm: 0,
      heightReference: 'stock_top', planeOffset: 0,
    } as ChamferParams,
    heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: CHAMFER_TOOL, loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function facePayload(loops: LoopData[]): FaceWorkerPayload {
  return {
    opId: 'op', setupId: 'su',
    params: {
      boundarySource: 'geometry', geometryId: 'g', loopIds: [],
      stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
      pattern: 'linear', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
      passExtension: 5, chipThinning: false,
      bothSidesPerLevel: false, floorStockToLeave: 0, finishPass: false,
      entryType: 'plunge', leadInRadius: 0, leadOutRadius: 0,
      keepToolDown: true, maxStayDownDistance: Infinity, extendBeforeRetract: false,
      transition: 'straight', tolerance: 0.01,
    } as FaceParams,
    heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: TOOL, loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function engravePayload(loops: LoopData[]): EngraveWorkerPayload {
  return {
    opId: 'op', setupId: 'su',
    params: {
      geometryId: '', loopIds: [], includeOpen: true, includeClosed: true,
      mode: 'trace', depthModel: 'constant', side: 'center', sideOffset: 0, axialOffset: 0,
      targetLineWidth: 0, useWidthForDepth: false, direction: 'as_drawn', tolerance: 0.01,
    } as EngraveParams,
    heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: TOOL, loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function acPayload(loops: LoopData[]): ACWorkerPayload {
  return {
    opId: 'op1', setupId: 's1',
    params: {
      geometryId: 'g1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6,
      stepDistance: 1, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
      helixDiameter: 90, tolerance: 0.02,
    } as ACParams,
    heights: HEIGHTS, passes: { ...PASSES, stepover: 1.2 },
    linking: { ...LINKING, entryType: 'ramp_helical', rampLength: 10, leadInRadius: 1, leadOutRadius: 1 },
    tool: TOOL, loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

describe('Loop-consumer census — refusal rows drive their builder with the partial-ellipse fixture', () => {
  it('Contour throws the named refusal', () => {
    expect(() => buildContourToolpath(contourPayload(PARTIAL_ELLIPSE_LOOPS))).toThrow(TABLE.COMPUTE_CONTOUR.refusalPattern!)
  })
  it('Pocket throws the named refusal', () => {
    expect(() => buildPocketToolpath(pocketPayload(PARTIAL_ELLIPSE_LOOPS))).toThrow(TABLE.COMPUTE_POCKET.refusalPattern!)
  })
  it('Drill throws the named refusal (empty-selection path)', () => {
    expect(() => buildDrillToolpath(drillPayload(PARTIAL_ELLIPSE_LOOPS))).toThrow(TABLE.COMPUTE_DRILL.refusalPattern!)
  })
  it('Drill throws when the open ARC loop is explicitly SELECTED by id (the worse-than-empty hazard: ' +
     'used to silently drill at the open arc centroid instead)', () => {
    const arcLoop = PARTIAL_ELLIPSE_LOOPS.find(l => l.points.length > 2)!
    const p = drillPayload(PARTIAL_ELLIPSE_LOOPS)
    p.params.loopIds = [arcLoop.id]
    expect(() => buildDrillToolpath(p)).toThrow(TABLE.COMPUTE_DRILL.refusalPattern!)
  })
  it('Bore throws the named refusal (empty-selection path: no closed circular loop in the bake)', () => {
    expect(() => buildBoreToolpath(borePayload(PARTIAL_ELLIPSE_LOOPS))).toThrow(TABLE.COMPUTE_BORE.refusalPattern!)
  })
  it('Bore throws the named refusal when the stored selection matches nothing (orphaned ids)', () => {
    const p = borePayload(PARTIAL_ELLIPSE_LOOPS)
    p.params.loopIds = ['orphaned-id-from-before-rederive']
    expect(() => buildBoreToolpath(p)).toThrow(TABLE.COMPUTE_BORE.refusalPattern!)
  })
  it('Thread mill throws the named refusal (empty-selection path)', () => {
    expect(() => buildThreadMillToolpath(threadMillPayload(PARTIAL_ELLIPSE_LOOPS))).toThrow(TABLE.COMPUTE_THREAD_MILL.refusalPattern!)
  })
  it('Thread mill throws when the open ARC loop is explicitly SELECTED by id', () => {
    const arcLoop = PARTIAL_ELLIPSE_LOOPS.find(l => l.points.length > 2)!
    const p = threadMillPayload(PARTIAL_ELLIPSE_LOOPS)
    p.params.loopIds = [arcLoop.id]
    expect(() => buildThreadMillToolpath(p)).toThrow(TABLE.COMPUTE_THREAD_MILL.refusalPattern!)
  })
  it('Chamfer throws the named refusal', () => {
    expect(() => buildChamferToolpath(chamferPayload(PARTIAL_ELLIPSE_LOOPS))).toThrow(TABLE.COMPUTE_CHAMFER.refusalPattern!)
  })
  it('Face throws the named refusal (builder-boundary defense-in-depth)', () => {
    expect(() => buildFaceToolpath(facePayload(PARTIAL_ELLIPSE_LOOPS))).toThrow(TABLE.COMPUTE_FACE.refusalPattern!)
  })
  it('Adaptive Clearing throws the named refusal (was silent console.warn + [])', async () => {
    await ensureEngineClipperReady()
    await expect(buildAdaptiveClearingToolpath(acPayload(PARTIAL_ELLIPSE_LOOPS))).rejects.toThrow(TABLE.COMPUTE_ADAPTIVE_CLEARING.refusalPattern!)
  })
})

describe('Loop-consumer census — the proven-safe builder row is NOT overreached into a refusal', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('Engrave does NOT throw on the partial-ellipse fixture (open loops are a supported input BY DESIGN)', () => {
    expect(() => buildEngraveToolpath(engravePayload(PARTIAL_ELLIPSE_LOOPS))).not.toThrow()
  })
})

// ── SKC-48: the CHAINED D-shape is a REAL cuttable closed region ────────────────────────────
// The mirror image of the refusal rows: the same two consumers that fail loud on the honest OPEN
// bake above must, on the SKC-48-CHAINED closed loop, produce a toolpath that actually CUTS. This
// drives the REAL builders (no mocks) and asserts a genuine cutting (feed) move exists — not merely
// a non-empty array (a lone rapid reposition would be non-empty yet cut nothing).
describe('Loop-consumer census — the SKC-48 chained D-shape yields a cutting toolpath (real builders)', () => {
  it('Contour on the D-shape closed loop emits cutting (feed) moves', () => {
    // Enable a finish pass so contour has a cutting mode (the shared PASSES has neither roughing
    // stock nor a finish pass — that is deliberate for the refusal rows, which never reach cutting).
    const payload = contourPayload(DSHAPE_LOOPS)
    payload.passes = { ...PASSES, finishPasses: 1 }
    const moves = buildContourToolpath(payload)
    expect(moves.length).toBeGreaterThan(0)
    expect(moves.some(m => m.type === 'feed' || m.type === 'arc_cw' || m.type === 'arc_ccw')).toBe(true)
  })
  it('Pocket on the D-shape closed loop emits cutting (feed) moves', () => {
    const moves = buildPocketToolpath(pocketPayload(DSHAPE_LOOPS))
    expect(moves.length).toBeGreaterThan(0)
    expect(moves.some(m => m.type === 'feed' || m.type === 'arc_cw' || m.type === 'arc_ccw')).toBe(true)
  })
})
