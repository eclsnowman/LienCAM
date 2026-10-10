import { describe, it, expect } from 'vitest'
import {
  validateToolNumbers,
  detectRotatedWcs,
  validateOpsCurrent,
  validateOpsReady,
  validateModelRefsVerifiedSinceLoad,
} from '../../lib/post/validate'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { postProject } from '../../lib/post/postProject'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import {
  makeTool, makeMachine, makeOp, makeStock, makeWcs, move, stampGenerationCurrent,
} from './helpers'
import type { PostOperation } from '../../lib/post/types'
import type { Project, Setup } from '../../types'

function postOp(op = makeOp(), tool = makeTool()): PostOperation {
  const machine = makeMachine()
  return {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves: op.toolpathMoves ?? [],
  }
}

describe('validateToolNumbers', () => {
  it('unique tool numbers pass', () => {
    const a = postOp(makeOp({ id: 'a', toolId: 't1' }), makeTool({ id: 't1', toolNumber: 1 }))
    const b = postOp(makeOp({ id: 'b', toolId: 't2' }), makeTool({ id: 't2', toolNumber: 2 }))
    expect(validateToolNumbers([a, b])).toEqual([])
  })

  it('same tool reused across ops does not flag a duplicate', () => {
    const tool = makeTool({ id: 't1', toolNumber: 1 })
    const a = postOp(makeOp({ id: 'a', toolId: 't1' }), tool)
    const b = postOp(makeOp({ id: 'b', toolId: 't1' }), tool)
    expect(validateToolNumbers([a, b])).toEqual([])
  })

  it('duplicate tool numbers on distinct tools fail', () => {
    const a = postOp(makeOp({ id: 'a', toolId: 't1' }), makeTool({ id: 't1', toolNumber: 1 }))
    const b = postOp(makeOp({ id: 'b', toolId: 't2' }), makeTool({ id: 't2', toolNumber: 1 }))
    const diags = validateToolNumbers([a, b])
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('TOOL_NUMBER_DUPLICATE')
    expect(diags[0].level).toBe('error')
  })

  it('missing tool number fails', () => {
    const a = postOp(makeOp(), makeTool({ toolNumber: undefined }))
    const diags = validateToolNumbers([a])
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('TOOL_NUMBER_MISSING')
  })
})

describe('detectRotatedWcs', () => {
  it('identity WCS passes', () => {
    expect(detectRotatedWcs(makeWcs())).toEqual([])
  })

  it('a pure rotation about Z passes (WO-299: yaw is now accepted)', () => {
    // xAxis = (cos t, -sin t, 0), yAxis = (sin t, cos t, 0) for t = 90deg.
    const rotated = makeWcs({
      xAxis: { x: 0, y: -1, z: 0 },
      yAxis: { x: 1, y: 0, z: 0 },
    })
    expect(detectRotatedWcs(rotated)).toEqual([])
  })

  it('a tilted zAxis fails, distinctly from a non-orthonormal or mirrored basis', () => {
    // Otherwise-orthonormal, right-handed basis rotated about X - a real tilt,
    // not yaw: zAxis is no longer vertical.
    const tilted = makeWcs({
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: Math.cos(0.1), z: Math.sin(0.1) },
      zAxis: { x: 0, y: -Math.sin(0.1), z: Math.cos(0.1) },
    })
    const diags = detectRotatedWcs(tilted)
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('WCS_ROTATED')
    expect(diags[0].message).toContain('not vertical')
  })

  it('a non-orthonormal basis fails, distinctly from a tilt or mirror', () => {
    // zAxis stays vertical and the axes stay mutually perpendicular, but
    // xAxis is not unit length - not a rotation at all.
    const scaled = makeWcs({ xAxis: { x: 1.01, y: 0, z: 0 } })
    const diags = detectRotatedWcs(scaled)
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('WCS_ROTATED')
    expect(diags[0].message).toContain('orthonormal')
  })

  it('a mirrored (left-handed) basis fails, distinctly from a tilt or non-orthonormal basis', () => {
    // Unit length, mutually perpendicular, zAxis vertical - but xAxis cross
    // yAxis points to -zAxis, not +zAxis: a reflection, not any rotation.
    const mirrored = makeWcs({
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: -1, z: 0 },
    })
    const diags = detectRotatedWcs(mirrored)
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('WCS_ROTATED')
    expect(diags[0].message).toContain('mirrored')
  })
})

describe('validateOpsCurrent', () => {
  it('a ready op passes', () => {
    expect(validateOpsCurrent([postOp(makeOp({ status: 'ready' }))])).toEqual([])
  })

  it('an outdated op fails with OP_OUTDATED naming the op', () => {
    const op = makeOp({ id: 'stale', name: 'Stale Op', status: 'outdated' })
    const diags = validateOpsCurrent([postOp(op)])
    expect(diags).toHaveLength(1)
    expect(diags[0].level).toBe('error')
    expect(diags[0].code).toBe('OP_OUTDATED')
    expect(diags[0].opId).toBe('stale')
    expect(diags[0].message).toContain('Stale Op')
    expect(diags[0].message).toContain('out of date')
  })

  it('an error op fails with OP_ERROR and includes the error message', () => {
    const op = makeOp({ id: 'bad', name: 'Bad Op', status: 'error', errorMessage: 'gouge detected' })
    const diags = validateOpsCurrent([postOp(op)])
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('OP_ERROR')
    expect(diags[0].message).toContain('Bad Op')
    expect(diags[0].message).toContain('gouge detected')
  })

  it('a computing op fails with OP_COMPUTING', () => {
    const op = makeOp({ id: 'busy', name: 'Busy Op', status: 'computing' })
    const diags = validateOpsCurrent([postOp(op)])
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('OP_COMPUTING')
    expect(diags[0].message).toContain('Busy Op')
  })

  it('a pending op fails with OP_PENDING', () => {
    const op = makeOp({ id: 'new', name: 'New Op', status: 'pending' })
    const diags = validateOpsCurrent([postOp(op)])
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('OP_PENDING')
    expect(diags[0].message).toContain('New Op')
  })

  it('a degraded op (CAM-1) fails with OP_DEGRADED and surfaces its model note', () => {
    const op = makeOp({
      id: 'gone', name: 'Gone Op', status: 'degraded',
      modelReferenceNote: 'Referenced model geometry was removed: 1 reference lost on B1.',
    })
    const diags = validateOpsCurrent([postOp(op)])
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('OP_DEGRADED')
    expect(diags[0].level).toBe('error')
    expect(diags[0].message).toContain('Gone Op')
    expect(diags[0].message).toContain('degraded')
    expect(diags[0].message).toContain('1 reference lost') // note included
  })
})

describe('validateOpsReady', () => {
  it('op with moves passes', () => {
    expect(validateOpsReady([postOp()])).toEqual([])
  })

  it('empty-moves op fails with opId set', () => {
    const op = makeOp({ id: 'empty', toolpathMoves: [] })
    const diags = validateOpsReady([postOp(op)])
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('OP_NO_TOOLPATH')
    expect(diags[0].opId).toBe('empty')
  })

  it('counts the move helper as non-empty', () => {
    const op = makeOp({ toolpathMoves: [move(), move({ x: 1 })] })
    expect(validateOpsReady([postOp(op)])).toEqual([])
  })

  it('does NOT fire OP_NO_TOOLPATH for a non-ready empty-moves op (validateOpsCurrent owns it)', () => {
    // A stale/outdated op also has empty moves; validateOpsReady must stay silent
    // so the op gets exactly ONE diagnostic (from validateOpsCurrent).
    const op = makeOp({ id: 'stale', status: 'outdated', toolpathMoves: [] })
    expect(validateOpsReady([postOp(op)])).toEqual([])
  })
})

// CAM-BINDING Stage 5 (charter RISK 2, load-boundary rehydration gap): a
// project loaded from a .camproject file starts with its ModelReferences
// UNVERIFIED against the live kernel until a real resolve pass runs this
// session (store's modelRefsVerifiedSinceLoad). This is the postprocessor
// half of that ordering fix - it refuses to post an op carrying a
// ModelReference until verified is true, regardless of the op's own status.
describe('validateModelRefsVerifiedSinceLoad', () => {
  const boundaryRef = [{ bodyId: 'F1', stableIds: ['F1:face-1'], role: 'machining-boundary' as const }]

  it('a "ready" op with a ModelReference, UNVERIFIED, still refuses (OP_MODEL_REFS_UNVERIFIED)', () => {
    const op = makeOp({ id: 'op-1', name: 'Boundary Op', status: 'ready', modelReferences: boundaryRef })
    const diags = validateModelRefsVerifiedSinceLoad([op], false)
    expect(diags).toHaveLength(1)
    expect(diags[0].level).toBe('error')
    expect(diags[0].code).toBe('OP_MODEL_REFS_UNVERIFIED')
    expect(diags[0].opId).toBe('op-1')
    expect(diags[0].message).toContain('Boundary Op')
  })

  it('the SAME op passes once verified is true - mutation-provable: hardcoding `false` here instead of the parameter would make this stay red', () => {
    const op = makeOp({ id: 'op-1', status: 'ready', modelReferences: boundaryRef })
    expect(validateModelRefsVerifiedSinceLoad([op], true)).toEqual([])
  })

  it('an op with NO ModelReference is unaffected by verified=false (this gate never fires for it)', () => {
    const op = makeOp({ id: 'op-2', status: 'ready' })
    expect(validateModelRefsVerifiedSinceLoad([op], false)).toEqual([])
  })

  it('verification is scoped by Model Item even when two references share raw body id F1', () => {
    const itemA = makeOp({
      id: 'op-a', name: 'Item A',
      modelReferences: [{ modelItemId: 'item-a', bodyId: 'F1', stableIds: ['edge-1'], role: 'edge-chain' }],
    })
    const itemB = makeOp({
      id: 'op-b', name: 'Item B',
      modelReferences: [{ modelItemId: 'item-b', bodyId: 'F1', stableIds: ['edge-1'], role: 'edge-chain' }],
    })
    const evidence = { 'item-b': true } as const
    expect(validateModelRefsVerifiedSinceLoad([itemB], evidence)).toEqual([])
    const diags = validateModelRefsVerifiedSinceLoad([itemA], evidence)
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({ code: 'OP_MODEL_REFS_UNVERIFIED', opId: 'op-a' })
    expect(diags[0].message).toContain('item-a')
  })

  it('an omitted modelItemId belongs only to the legacy item', () => {
    const legacy = makeOp({ modelReferences: boundaryRef })
    expect(validateModelRefsVerifiedSinceLoad([legacy], { 'item-b': true })).toHaveLength(1)
    expect(validateModelRefsVerifiedSinceLoad([legacy], { legacy: true })).toEqual([])
  })

  it('omitting the second argument defaults to verified (byte-compatible with every pre-Stage-5 call site)', () => {
    const op = makeOp({ id: 'op-1', status: 'ready', modelReferences: boundaryRef })
    // TS requires the argument at the call site; this exercises the SAME
    // effective default postProject.ts's own `options.modelRefsVerifiedSinceLoad
    // ?? true` fallback uses, so the two stay in lockstep.
    expect(validateModelRefsVerifiedSinceLoad([op], true)).toEqual([])
  })
})

describe('postProject per-Model-Item verification boundary', () => {
  function fixture(): { project: Project; setup: Setup } {
    const operation = (id: string, modelItemId: string) => makeOp({
      id,
      name: id,
      modelReferences: [{
        modelItemId,
        bodyId: 'F1',
        stableIds: ['edge-1'],
        role: 'edge-chain',
      }],
      toolpathMoves: [
        move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
        move({ type: 'feed', x: 1, y: 0, z: 0, role: 'cut' }),
      ],
    })
    const setup: Setup = {
      id: 'setup-1',
      name: 'Setup 1',
      wcs: makeWcs(),
      stock: makeStock(),
      operations: [operation('op-a', 'item-a'), operation('op-b', 'item-b')],
      notes: '',
    }
    const project = {
      id: 'project-1', name: 'Project', version: '1', createdAt: '', updatedAt: '',
      machine: makeMachine(), toolLibrary: [makeTool()], geometry: [], setups: [setup],
      activeSetupId: setup.id, activeOperationId: null, sceneStock: {}, notes: '',
    } as unknown as Project
    for (const op of setup.operations) {
      stampGenerationCurrent(project, setup, op, project.toolLibrary[0])
    }
    return { project, setup }
  }

  const options = {
    mode: 'combined' as const,
    pauseBetweenSetups: false,
    baseName: 'part',
    ext: 'nc',
  }

  it('resolving only item B cannot authorize item A, while selected B can post', () => {
    const { project, setup } = fixture()
    const evidence = { 'item-b': true } as const
    const itemA = postProject(project, [setup], UCCNC_CONFIG, {
      ...options,
      selectedOpIds: { [setup.id]: ['op-a'] },
      modelRefsVerifiedSinceLoad: evidence,
    })
    expect(itemA.ok).toBe(false)
    expect(itemA.diagnostics).toContainEqual(expect.objectContaining({
      code: 'OP_MODEL_REFS_UNVERIFIED',
      opId: 'op-a',
    }))

    const itemB = postProject(project, [setup], UCCNC_CONFIG, {
      ...options,
      selectedOpIds: { [setup.id]: ['op-b'] },
      modelRefsVerifiedSinceLoad: evidence,
    })
    expect(itemB.ok, JSON.stringify(itemB.diagnostics)).toBe(true)
  })

  it('both operations can post after both Model Items have session evidence', () => {
    const { project, setup } = fixture()
    const result = postProject(project, [setup], UCCNC_CONFIG, {
      ...options,
      modelRefsVerifiedSinceLoad: { 'item-a': true, 'item-b': true },
    })
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
  })
})
