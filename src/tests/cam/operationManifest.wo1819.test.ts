// WO-1819 stage 1 — the one operation manifest, proved three ways.
//
// 1. THE COMPILER, NOT A MEMORY. A fictitious member is added to the
//    OperationType union in a real TypeScript Program built over the real
//    sources, and src/lib/cam/operationManifest.ts is asserted to FAIL
//    compilation naming it. The control direction runs too: the unmodified
//    sources compile clean, and deleting an existing row fails naming that row.
//    Without all three, "satisfies Record<OperationType, ...>" is a claim.
//
// 2. BYTE-IDENTICAL DISPATCH. Every 2.5D row's buildRequest is driven and its
//    posted message compared against the message the pre-refactor chain built —
//    transcribed from src/store/index.ts as of 673f47db1 (the commit before
//    this order's first commit), branch by branch. The comparison is on the
//    full recursive KEY SET as well as the values, because the old chain's
//    conditional spreads OMIT fields rather than send them undefined, and a
//    present-but-undefined field is a different message on the wire.
//
// 3. ONE-TO-ONE WITH THE WORKER. The manifest's request types are compared
//    against the arms toolpathWorker.ts's TOOLPATH_BUILDERS table actually
//    declares, derived from its AST. The compiler already refuses a manifest
//    row naming a request type no worker handles; this catches the other
//    direction — a worker arm no operation can ever reach.
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  OPERATION_MANIFEST,
  OPERATION_MANIFEST_CONSUMERS,
  operationManifestEntry,
  type OperationRequestContext,
} from '../../kernel/registry'
import type { OperationType } from '../../types'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const MANIFEST_REL = 'src/kernel/registry.ts'
const TYPES_REL = 'src/types/index.ts'
const WORKER_REL = 'src/lib/cam/toolpathWorker.ts'

const norm = (p: string): string => p.replace(/\\/g, '/')
const abs = (rel: string): string => norm(resolve(REPO_ROOT, rel))

// ── 1. The compiler proof ───────────────────────────────────────────────────
//
// A Program rooted at the manifest, with a host that can OVERLAY the text of
// chosen files. Overlaying rather than editing the tree means the RED direction
// is committed and permanently re-run, and nothing has to be written into src/.
function manifestDiagnostics(overlay: Record<string, string> = {}): ts.Diagnostic[] {
  const sources = new Map<string, string>(
    Object.entries(overlay).map(([rel, text]) => [abs(rel), text]),
  )
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  }
  const host = ts.createCompilerHost(options, true)
  const readOverlaid = (f: string): string | undefined => sources.get(norm(f)) ?? ts.sys.readFile(f)
  const baseGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const overlaid = sources.get(norm(fileName))
    if (overlaid === undefined) return baseGetSourceFile(fileName, languageVersion, onError, shouldCreate)
    return ts.createSourceFile(fileName, overlaid, languageVersion, true, ts.ScriptKind.TS)
  }
  host.readFile = readOverlaid
  const program = ts.createProgram({ rootNames: [abs(MANIFEST_REL)], options, host })
  const manifestFile = program.getSourceFile(abs(MANIFEST_REL))
  if (!manifestFile) throw new Error(`manifest source not found in program: ${MANIFEST_REL}`)
  return [...program.getSemanticDiagnostics(manifestFile), ...program.getSyntacticDiagnostics(manifestFile)]
}

const messageOf = (d: ts.Diagnostic): string => ts.flattenDiagnosticMessageText(d.messageText, ' ')

const TYPES_SRC = readFileSync(resolve(REPO_ROOT, TYPES_REL), 'utf8')
const MANIFEST_SRC = readFileSync(resolve(REPO_ROOT, MANIFEST_REL), 'utf8')
const FICTITIOUS = 'sonic_erosion_2d'

describe('WO-1819 — the manifest is checked by the compiler, not by a memory', () => {
  it('compiles clean against the real sources (the control direction)', () => {
    const diags = manifestDiagnostics()
    expect(diags.map(messageOf)).toEqual([])
  }, 60_000)

  it('a fictitious OperationType makes the table FAIL to compile, naming it', () => {
    // The union ends with the last 3D member; a new member is appended exactly
    // as a real new operation would be added.
    const withFictitious = TYPES_SRC.replace(
      "  | 'pencil_3d'\n",
      `  | 'pencil_3d'\n  | '${FICTITIOUS}'\n`,
    )
    expect(withFictitious).not.toBe(TYPES_SRC)

    const diags = manifestDiagnostics({ [TYPES_REL]: withFictitious })
    const messages = diags.map(messageOf)
    expect(messages.length, `expected a compile error, got none:\n${messages.join('\n')}`).toBeGreaterThan(0)
    expect(messages.join('\n')).toContain(FICTITIOUS)
  }, 60_000)

  it('deleting an existing row makes the table FAIL to compile, naming that row', () => {
    // Cut the vcarve row out of the table literal — the same hole a forgotten
    // row would leave.
    const start = MANIFEST_SRC.indexOf('  vcarve: {')
    const end = MANIFEST_SRC.indexOf('  adaptive_clearing_2d: {')
    expect(start, 'vcarve row not found in the manifest source').toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const withoutVCarve = MANIFEST_SRC.slice(0, start) + MANIFEST_SRC.slice(end)

    const messages = manifestDiagnostics({ [MANIFEST_REL]: withoutVCarve }).map(messageOf)
    expect(messages.length, 'a missing row compiled clean — the Record check is not biting').toBeGreaterThan(0)
    expect(messages.join('\n')).toContain('vcarve')
  }, 60_000)
})

// ── 2. Byte-identical dispatch ──────────────────────────────────────────────

/** Every key path present in an object, so an ADDED or OMITTED field is caught
 *  even when its value would compare equal to undefined. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const out: string[] = []
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const path = prefix ? `${prefix}.${key}` : key
    out.push(path)
    out.push(...keyPaths((value as Record<string, unknown>)[key], path))
  }
  return out
}

const TOOL = { id: 'T1', diameter: 6, cutHand: 'right' } as const
const BASE_PAYLOAD = {
  opId: 'op-1',
  setupId: 'setup-1',
  heights: { topHeight: 0, bottomHeight: -10, clearanceHeight: 15, retractHeight: 5, feedHeight: 1 },
  passes: { stepover: 3, stepdown: 2, stockToLeave: 0.2, floorStockToLeave: 0.4, finishPasses: 0 },
  linking: { rampAngle: 3 },
  feedrateOverride: undefined,
  tool: TOOL,
  loops: [{ id: 'L1', closed: true, points: [] }],
  wcsOrigin: { x: 1, y: 2, z: 3 },
  holder: { id: 'H1' },
  stockBlock: { min: { x: 0, y: 0, z: -20 }, max: { x: 50, y: 50, z: 0 } },
  // Tool-reach inputs the store also spreads in; they must ride through every
  // builder untouched (the worker reads them through ToolReachInputs).
  clearanceAllowanceMm: 0.5,
  wcsLabel: 'G54',
}
const OP_HEIGHTS = { topHeight: -1, bottomHeight: -9, clearanceHeight: 15, retractHeight: 5, feedHeight: 1 }
const TOP = -2
const BOTTOM = -8
const FEATURE_BOTTOMS = { L1: -7 }

function contextFor(type: OperationType, extra: Partial<OperationRequestContext> = {}): OperationRequestContext {
  return {
    op: {
      id: 'op-1',
      type,
      params: { geometryId: 'g1', loopIds: ['L1'], tolerance: 0.01, floorStockToLeave: 0.4 },
      passes: BASE_PAYLOAD.passes,
    },
    basePayload: BASE_PAYLOAD,
    opHeights: OP_HEIGHTS,
    resolvedTopPlane: TOP,
    resolvedBottomPlane: BOTTOM,
    chamferBottomResolved: false,
    engraveBottomResolved: false,
    ...extra,
  } as unknown as OperationRequestContext
}

function requestFor(type: OperationType, extra: Partial<OperationRequestContext> = {}) {
  const route = operationManifestEntry(type).compute
  if (route.lane !== 'toolpath-worker') throw new Error(`${type} is not a toolpath-worker route`)
  return route.buildRequest(contextFor(type, extra))
}

/** The messages the PRE-REFACTOR chain built, transcribed branch by branch from
 *  src/store/index.ts at 673f47db1. Each case pairs a context with the exact
 *  message that chain posted for it. */
const PARAMS = { geometryId: 'g1', loopIds: ['L1'], tolerance: 0.01, floorStockToLeave: 0.4 }

/** WO-1820: what the store's earlier-pocket subtraction hands the face row -
 *  the rest region's outer boundary, and the pocket footprints as holes. */
const REST_LOOPS = [
  { id: '__rest_0__', closed: true, type: 'contour', points: [
    { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 },
  ] },
]
const REST_HOLES = [
  [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }],
]

const BYTE_IDENTICAL_CASES: Array<{
  name: string
  type: OperationType
  extra?: Partial<OperationRequestContext>
  expected: unknown
}> = [
  {
    name: 'pocket_2d sends both resolved planes',
    type: 'pocket_2d',
    expected: {
      type: 'COMPUTE_POCKET',
      payload: { ...BASE_PAYLOAD, params: PARAMS, heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM } },
    },
  },
  {
    name: 'drill keeps the op heights and omits holeBottoms when none resolved',
    type: 'drill',
    expected: { type: 'COMPUTE_DRILL', payload: { ...BASE_PAYLOAD, params: PARAMS } },
  },
  {
    name: 'drill sends holeBottoms and the stamped model loop ids when both exist',
    type: 'drill',
    extra: { featureBottoms: FEATURE_BOTTOMS, drillLoopIdsOverride: ['M1', 'M2'] },
    expected: {
      type: 'COMPUTE_DRILL',
      payload: { ...BASE_PAYLOAD, params: { ...PARAMS, loopIds: ['M1', 'M2'] }, holeBottoms: FEATURE_BOTTOMS },
    },
  },
  {
    name: 'bore sends both planes and omits boreBottoms when none resolved',
    type: 'bore',
    expected: {
      type: 'COMPUTE_BORE',
      payload: { ...BASE_PAYLOAD, params: PARAMS, heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM } },
    },
  },
  {
    name: 'bore sends boreBottoms when the smart resolution produced them',
    type: 'bore',
    extra: { featureBottoms: FEATURE_BOTTOMS },
    expected: {
      type: 'COMPUTE_BORE',
      payload: {
        ...BASE_PAYLOAD,
        params: PARAMS,
        heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM },
        boreBottoms: FEATURE_BOTTOMS,
      },
    },
  },
  {
    name: 'chamfer WITHOUT a smart bottom keeps the op bottom (bottomHeight not overridden)',
    type: 'chamfer',
    expected: {
      type: 'COMPUTE_CHAMFER',
      payload: { ...BASE_PAYLOAD, heights: { ...OP_HEIGHTS, topHeight: TOP }, params: PARAMS },
    },
  },
  {
    name: 'chamfer WITH a smart bottom overrides it, and uses the smart worker params',
    type: 'chamfer',
    extra: { chamferBottomResolved: true, chamferWorkerParams: { ...PARAMS, smart: true } as never },
    expected: {
      type: 'COMPUTE_CHAMFER',
      payload: {
        ...BASE_PAYLOAD,
        heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM },
        params: { ...PARAMS, smart: true },
      },
    },
  },
  {
    name: 'face zeroes BOTH legacy floor-allowance inputs',
    type: 'face',
    expected: {
      type: 'COMPUTE_FACE',
      payload: {
        ...BASE_PAYLOAD,
        heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM },
        passes: { ...BASE_PAYLOAD.passes, floorStockToLeave: 0 },
        params: { ...PARAMS, floorStockToLeave: 0 },
      },
    },
  },
  {
    // WO-1820 (landed on main while this order was building): a 'rest' face
    // posts the rest region in place of its resolved boundary, plus the holes
    // the earlier pockets already cleared. Expected message transcribed from
    // the `face` arm of the chain on main at 975197a07.
    name: 'a REST face posts the rest region and the earlier pockets as holes',
    type: 'face',
    extra: { face: { loops: REST_LOOPS, regionHoles: REST_HOLES } },
    expected: {
      type: 'COMPUTE_FACE',
      payload: {
        ...BASE_PAYLOAD,
        loops: REST_LOOPS,
        heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM },
        passes: { ...BASE_PAYLOAD.passes, floorStockToLeave: 0 },
        params: { ...PARAMS, floorStockToLeave: 0 },
        regionHoles: REST_HOLES,
      },
    },
  },
  {
    // An untouched rest region has NO holes, and the chain on main still posts
    // the field (an empty array), because regionHoles-present is what tells the
    // face builder it is running a rest boundary at all.
    name: 'a REST face with nothing subtracted still posts regionHoles, empty',
    type: 'face',
    extra: { face: { loops: REST_LOOPS, regionHoles: [] } },
    expected: {
      type: 'COMPUTE_FACE',
      payload: {
        ...BASE_PAYLOAD,
        loops: REST_LOOPS,
        heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM },
        passes: { ...BASE_PAYLOAD.passes, floorStockToLeave: 0 },
        params: { ...PARAMS, floorStockToLeave: 0 },
        regionHoles: [],
      },
    },
  },
  {
    name: 'engrave WITHOUT a smart bottom keeps the op bottom',
    type: 'engrave',
    expected: {
      type: 'COMPUTE_ENGRAVE',
      payload: { ...BASE_PAYLOAD, heights: { ...OP_HEIGHTS, topHeight: TOP }, params: PARAMS },
    },
  },
  {
    name: 'engrave WITH a smart bottom overrides it and uses the smart worker params',
    type: 'engrave',
    extra: { engraveBottomResolved: true, engraveWorkerParams: { ...PARAMS, smart: true } as never },
    expected: {
      type: 'COMPUTE_ENGRAVE',
      payload: {
        ...BASE_PAYLOAD,
        heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM },
        params: { ...PARAMS, smart: true },
      },
    },
  },
  {
    name: 'vcarve sends both resolved planes',
    type: 'vcarve',
    expected: {
      type: 'COMPUTE_VCARVE',
      payload: { ...BASE_PAYLOAD, params: PARAMS, heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM } },
    },
  },
  {
    // WO-3001 (new after the refactor, so pinned to the row itself): the spec depth is
    // measured down from the resolved top plane; with no spindle or machine bound stated
    // the message carries neither field.
    name: 'pattern sends both resolved planes and omits the unstated report inputs',
    type: 'pattern',
    expected: {
      type: 'COMPUTE_PATTERN',
      payload: { ...BASE_PAYLOAD, params: PARAMS, heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM } },
    },
  },
  {
    name: 'pattern carries the commanded spindle speed and the machine bounds it reports against',
    type: 'pattern',
    extra: { pattern: { spindleRpm: 18000, machine: { maxCuttingFeed: 5000, maxSpindleRpm: 24000 } } },
    expected: {
      type: 'COMPUTE_PATTERN',
      payload: {
        ...BASE_PAYLOAD,
        params: PARAMS,
        heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM },
        spindleRpm: 18000,
        machine: { maxCuttingFeed: 5000, maxSpindleRpm: 24000 },
      },
    },
  },
  {
    name: 'adaptive clearing keeps the op heights and carries loopOrigins',
    type: 'adaptive_clearing_2d',
    extra: { loopOrigins: { L1: { x: 4, y: 5 } } },
    expected: {
      type: 'COMPUTE_ADAPTIVE_CLEARING',
      // WO-2787 time-priced links add an explicit machine rapid field, even absent.
      payload: { ...BASE_PAYLOAD, params: PARAMS, machineRapidRate: undefined, loopOrigins: { L1: { x: 4, y: 5 } } },
    },
  },
  {
    name: 'thread mill sends both planes and the smart worker params when resolved',
    type: 'thread_mill',
    extra: { threadMillWorkerParams: { ...PARAMS, smart: true } as never },
    expected: {
      type: 'COMPUTE_THREAD_MILL',
      payload: {
        ...BASE_PAYLOAD,
        params: { ...PARAMS, smart: true },
        heights: { ...OP_HEIGHTS, topHeight: TOP, bottomHeight: BOTTOM },
      },
    },
  },
  {
    name: 'contour with tabs off and a closed path omits every optional field',
    type: 'contour_2d',
    extra: { contour: { params: PARAMS as never } },
    expected: { type: 'COMPUTE_CONTOUR', payload: { ...BASE_PAYLOAD, params: PARAMS } },
  },
  {
    name: 'contour carries loopBottoms, the tab stock bottom and the open-contour bounds',
    type: 'contour_2d',
    extra: {
      contour: {
        params: PARAMS as never,
        loopBottoms: { L1: -6 },
        stockBottomZ: -23,
        stockBounds: { min: { x: 0, y: 0 }, max: { x: 50, y: 50 } },
      },
    },
    expected: {
      type: 'COMPUTE_CONTOUR',
      payload: {
        ...BASE_PAYLOAD,
        params: PARAMS,
        loopBottoms: { L1: -6 },
        stockBottomZ: -23,
        stockBounds: { min: { x: 0, y: 0 }, max: { x: 50, y: 50 } },
      },
    },
  },
]

describe('WO-1819 — every row posts the message the old chain posted', () => {
  for (const testCase of BYTE_IDENTICAL_CASES) {
    it(testCase.name, () => {
      const actual = requestFor(testCase.type, testCase.extra)
      expect(actual).toEqual(testCase.expected)
      // The key set, not just the values: the old chain OMITS a field it has no
      // value for, and a present-but-undefined field is a different message.
      expect(keyPaths(actual)).toEqual(keyPaths(testCase.expected))
    })
  }

  it('the covered cases exercise every toolpath-worker row', () => {
    const covered = new Set(BYTE_IDENTICAL_CASES.map((c) => c.type))
    const toolpathRows = (Object.keys(OPERATION_MANIFEST) as OperationType[])
      .filter((type) => OPERATION_MANIFEST[type].compute.lane === 'toolpath-worker')
    expect([...covered].sort()).toEqual(toolpathRows.sort())
  })
})

// ── 3. The manifest, the OperationType union and the worker agree ───────────

/** The request types TOOLPATH_BUILDERS declares, read off toolpathWorker.ts's AST. */
function workerDispatchKeys(): string[] {
  const source = readFileSync(resolve(REPO_ROOT, WORKER_REL), 'utf8')
  const sf = ts.createSourceFile('toolpathWorker.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const keys: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'TOOLPATH_BUILDERS') {
      const table = node.initializer && ts.isSatisfiesExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer
      if (table && ts.isObjectLiteralExpression(table)) {
        for (const prop of table.properties) {
          if (!ts.isPropertyAssignment(prop)) continue
          if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) keys.push(prop.name.text)
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return keys
}

/** Every member of the OperationType union, read off src/types/index.ts's AST —
 *  derived, so a union edit cannot leave this file asserting a stale set. */
function operationTypeUnion(): string[] {
  const sf = ts.createSourceFile('types.ts', TYPES_SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const members: string[] = []
  sf.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'OperationType' && ts.isUnionTypeNode(node.type)) {
      for (const member of node.type.types) {
        if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) members.push(member.literal.text)
      }
    }
  })
  return members
}

describe('WO-1819 — the manifest is the whole enumeration', () => {
  it('has a row for every member of the OperationType union and no other', () => {
    expect(Object.keys(OPERATION_MANIFEST).sort()).toEqual(operationTypeUnion().sort())
  })

  it('every toolpath row names a distinct worker request type', () => {
    const requestTypes = (Object.keys(OPERATION_MANIFEST) as OperationType[])
      .map((type) => OPERATION_MANIFEST[type].compute)
      .filter((route) => route.lane === 'toolpath-worker')
      .map((route) => (route as { requestType: string }).requestType)
    expect(new Set(requestTypes).size).toBe(requestTypes.length)
  })

  it('the worker table serves exactly the request types the manifest routes to', () => {
    const requestTypes = (Object.keys(OPERATION_MANIFEST) as OperationType[])
      .map((type) => OPERATION_MANIFEST[type].compute)
      .filter((route) => route.lane === 'toolpath-worker')
      .map((route) => (route as { requestType: string }).requestType)
    expect(workerDispatchKeys().sort()).toEqual(requestTypes.sort())
  })

  it('exactly one row derives the contour tab preview', () => {
    const withPreview = (Object.keys(OPERATION_MANIFEST) as OperationType[])
      .filter((type) => {
        const route = OPERATION_MANIFEST[type].compute
        return route.lane === 'toolpath-worker' && (route as { derivesTabPreview: boolean }).derivesTabPreview
      })
    expect(withPreview).toEqual(['contour_2d'])
  })

  it('every 3D family is declared on the cam3d lane (stage 2 migrates its fork)', () => {
    const cam3dRows = (Object.keys(OPERATION_MANIFEST) as OperationType[])
      .filter((type) => OPERATION_MANIFEST[type].compute.lane === 'cam3d')
    expect(cam3dRows.sort()).toEqual(
      ['adaptive_3d', 'parallel_3d', 'pencil_3d', 'scallop_3d', 'steep_shallow_3d', 'waterline_3d'],
    )
  })

  it('every declared stage-2 consumer names a file that still exists and a follow-on slice', () => {
    expect(OPERATION_MANIFEST_CONSUMERS.length).toBeGreaterThan(0)
    for (const consumer of OPERATION_MANIFEST_CONSUMERS) {
      expect(existsSync(resolve(REPO_ROOT, consumer.file)), `${consumer.file} no longer exists`).toBe(true)
      expect(consumer.followOnSlice).toMatch(/WO-1819 stage 2/)
      expect(consumer.migrated).toBe(false)
    }
  })
})
