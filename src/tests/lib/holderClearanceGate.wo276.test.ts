// WO-276 — the holder crash check has to actually run.
//
// WO-262 built the stock primitive and WO-263 built the clearance arithmetic;
// neither had a caller outside its own test, so the crash they catch (the tool
// is too short for the pocket, the holder touches the top of the stock while the
// tip is deep) was still uncaught in the app. These tests are about the WIRING,
// so they drive the REAL worker entry point (self.onmessage in
// toolpathWorker.ts) rather than calling the gate and calling that proof:
//
//  1. A real pocket, built by the real pocket builder, with a stickout shorter
//     than the pocket is deep — the operation must refuse, naming the component
//     and the move. Lengthen the stickout and the SAME job must pass clean.
//     A test that only asserted "the gate was called" would pass while the
//     wiring was inert; this one fails if the guard is removed from the worker.
//  2. Every strategy the worker routes to a builder, ENUMERATED FROM
//     toolpathWorker.ts BY AST (the same derivation loop-consumer-census.test.ts
//     uses) — never a hand-written list of eight names that lets the ninth slip
//     through. Add a COMPUTE_* branch without the guard and this goes red.
//  3. A tool with no holder assigned must not fail, and computes quietly: an
//     undefined holder or stickout is the operator's decision (WO-1626, Operator
//     2026-09-16), so nothing about it reaches the console. A check that
//     genuinely cannot run for a reason nobody chose (no stock block, a
//     non-finite move) still reports "not checked".

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type {
  HeightParams, LinkingParams, PassParams, Tool, ToolHolder, ToolpathMove,
} from '../../types'
import type {
  LoopData, PocketParams, PocketWorkerPayload, ToolpathStockBlock,
  WorkerRequestMsg, WorkerResponseMsg,
} from '../../lib/cam/types'
import {
  checkHolderClearanceForToolpath,
  operationLabelForRequestType,
} from '../../lib/cam/holderClearanceGate'
import { typedMock } from '../support/typedMock'
import { evidenceOutDir } from '../helpers/evidenceScratch'

// Armed by the enumeration test: every builder the worker routes to returns
// these moves, so each COMPUTE_* branch is exercised without nine real
// toolpaths. Null = the real builder runs (the pocket case below).
const stub = vi.hoisted(() => ({ moves: null as ToolpathMove[] | null }))

vi.mock('../../lib/cam/pocket2d', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/pocket2d')>()
  return typedMock<typeof import('../../lib/cam/pocket2d')>({
    ...actual,
    buildPocketToolpath: (payload: PocketWorkerPayload, onProgress?: (fraction: number, phase?: string) => void) =>
      stub.moves ?? actual.buildPocketToolpath(payload, onProgress),
  })
})
vi.mock('../../lib/cam/contour2d', () => typedMock<typeof import('../../lib/cam/contour2d')>({
  buildContourToolpath: () => stub.moves ?? [],
}))
vi.mock('../../lib/cam/drill2d', () => typedMock<typeof import('../../lib/cam/drill2d')>({
  buildDrillToolpath: () => stub.moves ?? [],
}))
vi.mock('../../lib/cam/bore2d', () => typedMock<typeof import('../../lib/cam/bore2d')>({
  buildBoreToolpath: () => stub.moves ?? [],
}))
vi.mock('../../lib/cam/chamfer2d', () => typedMock<typeof import('../../lib/cam/chamfer2d')>({
  buildChamferToolpath: () => stub.moves ?? [],
}))
vi.mock('../../lib/cam/face2d', () => typedMock<typeof import('../../lib/cam/face2d')>({
  buildFaceToolpath: () => stub.moves ?? [],
}))
vi.mock('../../lib/cam/engrave2d', () => typedMock<typeof import('../../lib/cam/engrave2d')>({
  buildEngraveToolpath: () => stub.moves ?? [],
}))
vi.mock('../../lib/cam/threadmill2d', () => typedMock<typeof import('../../lib/cam/threadmill2d')>({
  buildThreadMillToolpath: () => stub.moves ?? [],
}))
// WO-1174 added COMPUTE_VCARVE to the worker without adding its builder here,
// so this case alone ran the REAL engine: it refused the flat end mill on tip
// angle before any move existed, and the guard below went unproven for V-carve.
// Red on main from 2026-09-02 until 2026-09-04.
vi.mock('../../lib/cam/vcarve2d', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/vcarve2d')>()
  return typedMock<typeof import('../../lib/cam/vcarve2d')>({
    ...actual,
    buildVCarveToolpath: () => stub.moves ?? [],
  })
})
vi.mock('../../lib/cam/adaptiveClearing2d/engine', () => typedMock<typeof import('../../lib/cam/adaptiveClearing2d/engine')>({
  buildAdaptiveClearingToolpath: async () => stub.moves ?? [],
}))

// ── The stock, the tool and the holder ───────────────────────────────────────
// A 60 x 60 x 10 mm block whose top sits at the WCS zero plane, so a move's Z is
// also its depth below the top of the stock.

const STOCK: ToolpathStockBlock = {
  min: { x: 0, y: 0, z: -10 },
  max: { x: 60, y: 60, z: 0 },
}

const HOLDER: ToolHolder = {
  id: 'holder-1',
  name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
    diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    lengthBelowHolder: 5, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: {
      default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 3, stepover: 1.5 },
    },
    ...overrides,
  } as unknown as Tool
}

const POCKET_DEPTH_MM = 8

const HEIGHTS: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -POCKET_DEPTH_MM, bottomHeightMode: 'absolute',
} as unknown as HeightParams

const PASSES: PassParams = {
  stepdown: 3, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0,
} as unknown as PassParams

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
} as unknown as LinkingParams

const POCKET_PARAMS: PocketParams = {
  geometryId: 'geo-1', loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
  fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
  helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
}

const POCKET_LOOP: LoopData = {
  id: 'loop-1', closed: true, type: 'contour',
  points: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }],
}

/** A short hand-built path that plunges below the top of the block. */
const CRASH_MOVES: ToolpathMove[] = [
  { type: 'rapid', x: 30, y: 30, z: 15, role: 'rapid' },
  { type: 'feed', x: 30, y: 30, z: -POCKET_DEPTH_MM, role: 'cut' },
  { type: 'feed', x: 40, y: 30, z: -POCKET_DEPTH_MM, role: 'cut' },
]

// ── Drive the real worker entry point ────────────────────────────────────────

type WorkerHandler = (event: MessageEvent<WorkerRequestMsg>) => Promise<void> | void

let handler: WorkerHandler | undefined
const posted: WorkerResponseMsg[] = []

beforeAll(async () => {
  // toolpathWorker.ts installs self.onmessage at import and answers through
  // self.postMessage; node has no `self`, so stand one up and import the module
  // exactly as the worker runtime would.
  ;(globalThis as unknown as Record<string, unknown>).self = {
    set onmessage(fn: WorkerHandler) { handler = fn },
    postMessage: (message: WorkerResponseMsg) => { posted.push(message) },
  }
  await import('../../lib/cam/toolpathWorker')
  expect(handler, 'toolpathWorker.ts installed no self.onmessage').toBeTypeOf('function')
})

/** Post one request and return the terminal response (progress is not one). */
async function runWorker(message: unknown): Promise<WorkerResponseMsg> {
  posted.length = 0
  await handler!({ data: message } as MessageEvent<WorkerRequestMsg>)
  const terminal = posted.filter((response) => response.type !== 'TOOLPATH_PROGRESS')
  expect(terminal, 'the worker posted no terminal response').toHaveLength(1)
  return terminal[0]
}

function pocketRequest(stickoutMm: number): unknown {
  return {
    type: 'COMPUTE_POCKET',
    payload: {
      opId: 'op-1', setupId: 'setup-1',
      params: POCKET_PARAMS, heights: HEIGHTS, passes: PASSES, linking: LINKING,
      tool: tool({ lengthBelowHolder: stickoutMm }),
      loops: [POCKET_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
      holder: HOLDER, stockBlock: STOCK,
    } satisfies PocketWorkerPayload,
  }
}

// ── 1. The real too-short case, end to end ───────────────────────────────────

describe('WO-276 a real pocket deeper than the stickout', () => {
  let refusal: WorkerResponseMsg
  let cleaned: WorkerResponseMsg

  beforeAll(async () => {
    stub.moves = null                       // the REAL pocket builder runs here
    refusal = await runWorker(pocketRequest(5))
    cleaned = await runWorker(pocketRequest(POCKET_DEPTH_MM + 4))
  })

  it('refuses the operation, naming the component and the move', () => {
    expect(refusal.type).toBe('TOOLPATH_ERROR')
    const message = (refusal as { message: string }).message
    expect(message).toMatch(/^Pocket: the holder would hit the stock\./)
    expect(message).toMatch(/Move \d+ of \d+ \(X [\d.-]+ Y [\d.-]+ Z [\d.-]+\) drives the holder into the block/)
    expect(message).toMatch(/8\.000 mm below the top of the stock/)
    // WO-081: the refusal carries its action, it does not name a button.
    expect(message).toMatch(/set the tool's stickout below the holder past 8\.000 mm \(it is 5\.000 mm now\)/)
    expect(message).toMatch(/fit a shorter holder/)
    expect(message).toMatch(/keep this pass within 5\.000 mm of the top of the stock/)
    // The honest limit is in the message, not only in a comment.
    expect(message).toMatch(/knows the block, not the machined shape/)
  })

  it('proves the refusal came from the guard and not from an empty toolpath', () => {
    // The same job with the same tool geometry, checked directly: a real path
    // was built (the builder is not mocked here) and it really does collide.
    stub.moves = null
    const gate = checkHolderClearanceForToolpath({
      operation: 'Pocket',
      moves: (cleaned as { moves: ToolpathMove[] }).moves,
      tool: tool({ lengthBelowHolder: 5 }),
      holder: HOLDER,
      stockBlock: STOCK,
    })
    expect(gate.status).toBe('collision')
    expect(gate.report?.collisions.length).toBeGreaterThan(0)
    expect(gate.report?.collisions[0].components).toEqual(['holder'])
  })

  it('passes the same job clean once the stickout clears the block', () => {
    expect(cleaned.type).toBe('TOOLPATH_COMPLETE')
    const moves = (cleaned as { moves: ToolpathMove[] }).moves
    expect(moves.length).toBeGreaterThan(0)
    expect(Math.min(...moves.map((move) => move.z))).toBeCloseTo(-POCKET_DEPTH_MM, 6)

    const gate = checkHolderClearanceForToolpath({
      operation: 'Pocket',
      moves,
      tool: tool({ lengthBelowHolder: POCKET_DEPTH_MM + 4 }),
      holder: HOLDER,
      stockBlock: STOCK,
    })
    expect(gate.status).toBe('clear')
    expect(gate.message).toBeUndefined()
  })

  // ── The capture Operator judges the wording by (Tier 2 evidence) ──────────────
  it('captures what the machinist sees', () => {
    const shankTool = tool({ fluteLength: 5, shankDiameter: 10, lengthBelowHolder: 14 })
    const shank = checkHolderClearanceForToolpath({
      operation: 'Contour', moves: CRASH_MOVES, tool: shankTool,
      holder: { ...HOLDER, segments: [{ height: 40, lowerDiameter: 12, upperDiameter: 12 }] },
      stockBlock: STOCK,
    })
    const noHolder = checkHolderClearanceForToolpath({
      operation: 'Drill', moves: CRASH_MOVES,
      tool: tool({ holderId: undefined }), stockBlock: STOCK,
    })
    const noStock = checkHolderClearanceForToolpath({
      operation: 'Face', moves: CRASH_MOVES, tool: tool(), holder: HOLDER,
    })
    expect(shank.status).toBe('collision')
    expect(shank.message).toMatch(/the shank would hit the stock/)
    // WO-1626 (Operator, 2026-09-16): an undefined holder is the operator's
    // decision, not ours to nag about - the operation computes and reports
    // ready, with nothing said about the holder.
    expect(noHolder.status).toBe('clear')
    expect(noHolder.message).toBeUndefined()
    expect(noStock.status).toBe('not-checked')

    const capture = [
      'WO-276 - what the machinist sees when the holder would hit the stock.',
      '',
      'Each block is the exact text of the operation\'s refusal or warning, as the',
      'operation carries it (a collision is posted as TOOLPATH_ERROR and lands on',
      'the operation as its error message; "not checked" is warned, never a pass).',
      'Generated by src/tests/lib/holderClearanceGate.wo276.test.ts on the same run',
      'that asserts it, so it cannot drift from the product.',
      '',
      '1. HOLDER COLLISION - a real 8 mm deep pocket, 6 mm tool, 5 mm of stickout,',
      '   built by the real pocket builder and refused by the worker:',
      '',
      (refusal as { message: string }).message,
      '',
      '2. SHANK COLLISION - the flutes are shorter than the pass is deep:',
      '',
      shank.message ?? '',
      '',
      '3. QUIET (WO-1626) - the tool has no holder assigned. That is the',
      '   operator\'s decision, not a fault: the operation reports ready and says',
      '   nothing about the holder:',
      '',
      '(no message - the operation reported ready)',
      '',
      '4. NOT CHECKED - the setup has no resolvable stock block:',
      '',
      noStock.message ?? '',
      '',
    ].join('\n')

    const dir = evidenceOutDir(join(process.cwd(), 'src', 'tests', 'evidence', 'WO-276'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'holder-crash-message.txt'), capture, 'utf8')
    expect(capture).toContain('Pocket: the holder would hit the stock.')
  })
})

// ── 2. Every strategy the worker dispatches goes through the guard ───────────

/** Every `msg.type === 'COMPUTE_*'` branch in toolpathWorker.ts that routes to a
 *  build*Toolpath call, derived from the file itself. Nesting produces
 *  placements, not moves, and routes to runNest — it is excluded by the
 *  derivation, not by a name in a list. */
function dispatchedStrategies(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'toolpathWorker.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  )
  const found: string[] = []

  const msgTypeOf = (condition: ts.Expression): string | undefined => {
    if (!ts.isBinaryExpression(condition) ||
        condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return undefined
    const literal = ts.isStringLiteral(condition.right)
      ? condition.right
      : ts.isStringLiteral(condition.left) ? condition.left : undefined
    return literal?.text
  }

  const buildsAToolpath = (node: ts.Node): boolean => {
    let hit = false
    const visit = (child: ts.Node) => {
      if (hit) return
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) &&
          /^build\w+Toolpath$/.test(child.expression.text)) {
        hit = true
        return
      }
      child.forEachChild(visit)
    }
    visit(node)
    return hit
  }

  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node)) {
      const msgType = msgTypeOf(node.expression)
      if (msgType && buildsAToolpath(node.thenStatement)) found.push(msgType)
    }
    // WO-1819: the worker routes through the TOOLPATH_BUILDERS table now. Each
    // row whose body calls a build*Toolpath is a dispatched strategy, derived
    // the same way the branches are - never from a hand list.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === 'TOOLPATH_BUILDERS' && node.initializer) {
      const table = ts.isSatisfiesExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer
      if (ts.isObjectLiteralExpression(table)) {
        for (const row of table.properties) {
          if (!ts.isPropertyAssignment(row)) continue
          const key = ts.isIdentifier(row.name) || ts.isStringLiteral(row.name) ? row.name.text : undefined
          if (key && buildsAToolpath(row.initializer)) found.push(key)
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return [...new Set(found)]
}

/** Every request type the protocol declares, from the WorkerRequestMsg union. */
function declaredRequestTypes(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'types.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  )
  const types: string[] = []
  sourceFile.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'WorkerRequestMsg') return
    if (!ts.isUnionTypeNode(node.type)) return
    for (const member of node.type.types) {
      if (!ts.isTypeLiteralNode(member)) continue
      for (const property of member.members) {
        if (!ts.isPropertySignature(property) || !property.name || !property.type) continue
        if (!ts.isIdentifier(property.name) || property.name.text !== 'type') continue
        if (ts.isLiteralTypeNode(property.type) && ts.isStringLiteral(property.type.literal)) {
          types.push(property.type.literal.text)
        }
      }
    }
  })
  return types
}

describe('WO-276 every dispatched strategy is guarded', () => {
  const STRATEGIES = dispatchedStrategies(
    readFileSync(join(process.cwd(), 'src', 'lib', 'cam', 'toolpathWorker.ts'), 'utf8'),
  )

  it('derives the strategy list from toolpathWorker.ts rather than a hand list', () => {
    expect(STRATEGIES.length).toBeGreaterThanOrEqual(8)
    expect(STRATEGIES).not.toContain('COMPUTE_NEST')
    expect(STRATEGIES.every((type) => type.startsWith('COMPUTE_'))).toBe(true)

    // Two-way: every toolpath request the protocol declares is a strategy the
    // worker routes (and therefore guards below). A request type added to
    // types.ts with no guarded branch turns this red instead of slipping
    // through as the strategy nobody remembered. Nesting produces placements,
    // not moves, and is the one deliberate exclusion.
    const declared = declaredRequestTypes(
      readFileSync(join(process.cwd(), 'src', 'lib', 'cam', 'types.ts'), 'utf8'),
    ).filter((type) => type !== 'COMPUTE_NEST')
    expect([...STRATEGIES].sort()).toEqual([...declared].sort())
  })

  // Per-type params where the generic pocket params cannot reach the builder.
  // COMPUTE_PATTERN (WO-2982/WO-3001) validates its spec before it generates, so
  // pocket params are refused as "Pattern spec: must be a pattern object." and
  // the guard is never reached. Its builder is NOT stubbed: this minimal valid
  // spec (a 5 mm circle at the region centroid, constant depth -> the resolved
  // Top - Bottom = 8 mm) makes the REAL pattern builder cut 8 mm deep inside the
  // block, which the 5 mm stickout cannot reach without the holder - the same
  // real-path proof the pocket case above gives.
  const PARAMS_FOR: Partial<Record<string, unknown>> = {
    COMPUTE_PATTERN: {
      geometryId: 'geo-1', loopIds: [],
      spec: {
        version: 1, units: 'mm', anchor: 'region-centroid',
        curves: [{ kind: 'polar', r: '5', t: [0, 360] }],
        depth: POCKET_DEPTH_MM,
      },
    },
  }

  it.each(STRATEGIES)('%s refuses a toolpath that puts the holder in the stock', async (type) => {
    stub.moves = CRASH_MOVES
    try {
      const response = await runWorker({
        type,
        payload: {
          opId: `op-${type}`, setupId: 'setup-1',
          params: PARAMS_FOR[type] ?? { ...POCKET_PARAMS }, heights: HEIGHTS, passes: PASSES, linking: LINKING,
          tool: tool(), loops: [POCKET_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
          holder: HOLDER, stockBlock: STOCK,
        },
      })
      expect(response.type).toBe('TOOLPATH_ERROR')
      const message = (response as { message: string }).message
      expect(message).toContain('the holder would hit the stock')
      expect(message).toContain(operationLabelForRequestType(type))
    } finally {
      stub.moves = null
    }
  })

  it('labels each strategy from its message type instead of a hand-written map', () => {
    expect(operationLabelForRequestType('COMPUTE_THREAD_MILL')).toBe('Thread mill')
    expect(operationLabelForRequestType('COMPUTE_ADAPTIVE_CLEARING')).toBe('Adaptive clearing')
    expect(operationLabelForRequestType('COMPUTE_POCKET')).toBe('Pocket')
  })
})

// ── 3. An undefined holder or stickout computes quietly (WO-1626) ───────────
// A genuinely unresolvable check (no stock block, a non-finite coordinate)
// still reports "not checked" below - that limit is not the operator's choice.

describe('WO-276/WO-1626 a tool with no holder computes quietly, never nags', () => {
  it('does not fail the operation, and says nothing about the missing holder', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stub.moves = CRASH_MOVES
    try {
      const response = await runWorker({
        type: 'COMPUTE_POCKET',
        payload: {
          opId: 'op-no-holder', setupId: 'setup-1',
          params: POCKET_PARAMS, heights: HEIGHTS, passes: PASSES, linking: LINKING,
          tool: tool({ holderId: undefined }), loops: [POCKET_LOOP],
          wcsOrigin: { x: 0, y: 0, z: 0 }, stockBlock: STOCK,
        },
      })
      expect(response.type).toBe('TOOLPATH_COMPLETE')
      // Operator ruling 2026-09-16: an undefined holder is the operator's decision, not
      // ours to nag about - no console line, on any operation.
      expect(warn).not.toHaveBeenCalled()
    } finally {
      stub.moves = null
      warn.mockRestore()
    }
  })

  it('reports missing-profile and missing-stickout as clear, quietly', () => {
    const noHolder = checkHolderClearanceForToolpath({
      operation: 'Pocket', moves: CRASH_MOVES, tool: tool({ holderId: undefined }),
      stockBlock: STOCK,
    })
    expect(noHolder.status).toBe('clear')
    expect(noHolder.report?.holderStatus).toBe('missing-profile')
    expect(noHolder.message).toBeUndefined()

    const noStickout = checkHolderClearanceForToolpath({
      operation: 'Pocket', moves: CRASH_MOVES,
      tool: tool({ lengthBelowHolder: undefined }), holder: HOLDER, stockBlock: STOCK,
    })
    expect(noStickout.status).toBe('clear')
    expect(noStickout.report?.holderStatus).toBe('missing-stickout')
    expect(noStickout.message).toBeUndefined()

    const noStock = checkHolderClearanceForToolpath({
      operation: 'Pocket', moves: CRASH_MOVES, tool: tool(), holder: HOLDER,
    })
    expect(noStock.status).toBe('not-checked')
    expect(noStock.message).toContain('no resolvable stock block')
  })

  it('reports clear only when the check really ran and found nothing', () => {
    const gate = checkHolderClearanceForToolpath({
      operation: 'Pocket',
      moves: CRASH_MOVES,
      tool: tool({ lengthBelowHolder: 20 }),
      holder: HOLDER,
      stockBlock: STOCK,
    })
    expect(gate.status).toBe('clear')
    expect(gate.report?.complete).toBe(true)
    expect(gate.report?.collisions).toEqual([])
  })

  it('says "not checked" for a path carrying a non-finite coordinate', () => {
    const broken = [...CRASH_MOVES, { type: 'feed', x: 30, y: Number.NaN, z: -4, role: 'cut' } as ToolpathMove]
    const gate = checkHolderClearanceForToolpath({
      operation: 'Pocket', moves: broken, tool: tool(), holder: HOLDER, stockBlock: STOCK,
    })
    expect(gate.status).toBe('not-checked')
    expect(gate.message).toContain('non-finite coordinate')
  })

  it('handles a six-figure toolpath without overflowing the stack', () => {
    // A real path runs to this many moves; anything that spreads them into a
    // Math.min call throws RangeError long before this size.
    const many: ToolpathMove[] = Array.from({ length: 150_000 }, (_, index) => ({
      type: 'feed', x: 10 + (index % 40), y: 10 + (index % 40), z: 4, role: 'cut',
    }))
    const gate = checkHolderClearanceForToolpath({
      operation: 'Pocket', moves: many, tool: tool(), holder: HOLDER, stockBlock: STOCK,
    })
    expect(gate.status).toBe('clear')
  })

  it('checks a path that only touches the block in XY where the tool actually is', () => {
    // The same crashing depths, but the whole path sits clear of the block in
    // XY: nothing is under the holder, so this is clear rather than refused.
    const away = CRASH_MOVES.map((move) => ({ ...move, x: move.x + 400 }))
    const gate = checkHolderClearanceForToolpath({
      operation: 'Pocket', moves: away, tool: tool(), holder: HOLDER, stockBlock: STOCK,
    })
    expect(gate.status).toBe('clear')
  })
})

// ── 4. The lane's own contract: the payload carries the check's inputs ───────

describe('WO-276 the request shape carries the crash-guard inputs once', () => {
  it('declares holder and stockBlock on the shared inputs, not per strategy', () => {
    const typesSource = readFileSync(
      join(process.cwd(), 'src', 'lib', 'cam', 'types.ts'), 'utf8',
    )
    const sourceFile = ts.createSourceFile(
      'types.ts', typesSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
    )
    const extendsInputs = new Set<string>()
    let inputsMembers: string[] = []
    sourceFile.forEachChild((node) => {
      if (!ts.isInterfaceDeclaration(node)) return
      if (node.name.text === 'HolderClearanceInputs') {
        inputsMembers = node.members
          .filter(ts.isPropertySignature)
          .map((member) => (member.name && ts.isIdentifier(member.name) ? member.name.text : ''))
      }
      const inherits = node.heritageClauses?.some((clause) =>
        clause.types.some((type) =>
          ts.isIdentifier(type.expression) && type.expression.text === 'HolderClearanceInputs'))
      if (inherits) extendsInputs.add(node.name.text)
    })

    expect(inputsMembers).toEqual(['holder', 'stockBlock'])
    // Every toolpath payload — the nest payload is not a toolpath and must not
    // pick these up.
    const payloads = [...extendsInputs].sort()
    expect(payloads.length).toBeGreaterThanOrEqual(9)
    expect(payloads).not.toContain('NestWorkerPayload')
    expect(payloads.every((name) => name.endsWith('WorkerPayload'))).toBe(true)
  })
})
