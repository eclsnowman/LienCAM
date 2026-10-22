// WO-3020 (alpha.3 A3-11): unit tests for the kernel heights service - the one
// plane-order validator (each strictness case, Top = Bottom as today), owner
// precedence (user override > operation policy > setup default), the policies
// at parity, and the service being deterministic, headless and kernel-only.
// Today's resolver is the oracle wherever a case resolves a plan.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as today from '../../lib/cam/smartHeights'
import { resolveAdaptive3dTraversePlanes } from '../../cam3d/integration/adaptive3dOperation'
import * as kernel from '../../kernel/heights'
import type {
  HeightEvidenceContext,
  OperationHeightIntentV2,
  SmartHeightEvidenceKind,
  SmartHeightEvidenceNode,
  SmartHeightEvidenceRole,
  SmartHeightIntentOwner,
} from '../../kernel/heights'

const setupOwner: SmartHeightIntentOwner = { kind: 'setup', setupId: 'setup-1' }
const policyOwner: SmartHeightIntentOwner = { kind: 'operation_policy' }
const userOwner: SmartHeightIntentOwner = { kind: 'user_override' }

const node = (id: string, kind: SmartHeightEvidenceKind, role: SmartHeightEvidenceRole, valueMm?: number): SmartHeightEvidenceNode => ({
  id, kind, role, entityId: `${kind}:${id}`, dependencyNodeIds: [], dependencyFingerprint: `fp:${id}`,
  ...(valueMm === undefined ? {} : { scalar: { frame: 'wcs', valueMm } as const }),
})

const context = (operationType: HeightEvidenceContext['operationType'], evidence: SmartHeightEvidenceNode[]): HeightEvidenceContext => ({
  revision: { projectRevision: 'p', setupRevision: 's', operationRevision: 'o' },
  operationType, wcsOriginMachineMm: 100, evidence,
})

function faceIntent(overrides: Partial<OperationHeightIntentV2> = {}): OperationHeightIntentV2 {
  return {
    version: kernel.SMART_HEIGHT_INTENT_VERSION,
    policyVersion: kernel.SMART_HEIGHT_POLICY_VERSION,
    policy: { operationType: 'face', variant: 'target_face' },
    safety: {
      clearance: { reference: 'retract', offsetMm: 10, owner: setupOwner },
      retract: { reference: 'stock_top', offsetMm: 5, owner: setupOwner },
      feed: { reference: 'top', offsetMm: 2, owner: setupOwner },
    },
    machining: {
      start: { value: { kind: 'policy_default' }, owner: policyOwner },
      end: { value: { kind: 'policy_default' }, owner: policyOwner },
      scope: { value: { kind: 'selected_geometry', geometryIds: ['part-1'] }, owner: policyOwner },
    },
    ...overrides,
  }
}

const faceEvidence = (targetZ = -2, stockTop = 0): SmartHeightEvidenceNode[] => [
  node('stock-top', 'owning_stock', 'stock_top', stockTop),
  node('target-model', 'target_model', 'target_top', 0),
  node('target-face', 'selected_plane', 'selected_plane', targetZ),
  node('scope', 'operation_scope', 'scope'),
]

/** Kernel and today on the same input; they must agree, and the kernel's answer is returned. */
function both(intent: OperationHeightIntentV2, ctx: HeightEvidenceContext) {
  const ours = kernel.resolveHeightPlan(intent, ctx)
  expect(ours).toEqual(today.resolveSmartHeightPlan(intent, ctx))
  return ours
}

describe('WO-3020 plane-order validator: Clearance >= Retract >= Feed >= Top >= Bottom', () => {
  const ok = { clearance: 30, retract: 20, feed: 10, top: 0, bottom: -5 }

  it('accepts a strictly ordered stack and equal neighbours', () => {
    expect(kernel.planeOrderViolation(ok, { endIsTargetField: false })).toBeUndefined()
    expect(kernel.planeOrderViolation({ clearance: 5, retract: 5, feed: 5, top: 5, bottom: -1 }, { endIsTargetField: false }))
      .toBeUndefined()
  })

  it.each([
    ['Clearance', 'Retract', { ...ok, clearance: 19 }],
    ['Retract', 'Feed', { ...ok, retract: 9 }],
    ['Feed', 'Material Start', { ...ok, feed: -1 }],
  ] as const)('refuses %s below %s with today\'s words', (upper, lower, stack) => {
    const violation = kernel.planeOrderViolation(stack, { endIsTargetField: false })
    expect(violation).toMatchObject({ upper, lower })
    expect(violation!.message).toMatch(/safety planes must satisfy Clearance >= Retract >= Feed >= Material Start\.$/)
  })

  it('refuses Bottom above Top', () => {
    expect(kernel.planeOrderViolation({ ...ok, bottom: 1 }, { endIsTargetField: true })).toMatchObject({
      upper: 'Material Start', lower: 'Target End',
      message: 'Material Start (0) must be above the cutter-center Target End (1).',
    })
  })

  it('Top = Bottom: refused on a scalar end, accepted on a target field - as today (MD-56 is a card, not built)', () => {
    expect(kernel.bandOrderViolation(0, 0, false)?.message).toBe('Material Start (0) must be above the cutter-center Target End (0).')
    expect(kernel.bandOrderViolation(0, 0, true)).toBeUndefined()
    // Through the resolvers: a Face whose target face sits at the stock top.
    const scalarEnd = both(faceIntent(), context('face', faceEvidence(0)))
    expect(scalarEnd).toMatchObject({ ok: false, refusal: { code: 'invalid_plane_order' } })
    // A target-surface field whose top is the Material Start resolves.
    const field: SmartHeightEvidenceNode = {
      ...node('field', 'target_surface_field', 'target_artifact', 0),
      spatial: {
        artifactId: 'field', schemaVersion: 1, representation: 'mesh', frame: 'wcs', fingerprint: 'fp-field',
        boundsMm: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 0 },
      },
    }
    const parallel: OperationHeightIntentV2 = {
      ...faceIntent(),
      policy: { operationType: 'parallel_3d', variant: 'target_surface' },
      machining: {
        start: { value: { kind: 'target_model_top' }, owner: policyOwner },
        end: { value: { kind: 'target_surface' }, owner: policyOwner },
        scope: { value: { kind: 'whole_target', geometryIds: ['part-1'] }, owner: policyOwner },
      },
    }
    const fieldEnd = both(parallel, context('parallel_3d', [
      node('stock-top', 'owning_stock', 'stock_top', 0), node('target-model', 'target_model', 'target_top', 0),
      field, node('scope', 'operation_scope', 'scope'),
    ]))
    expect(fieldEnd.ok && [fieldEnd.plan.machining.materialStart.wcsMm, fieldEnd.plan.machining.cutterCenterEnd?.wcsMm]).toEqual([0, 0])
    // The 2.5D fixed-step ladder gives Top = Bottom one level; Adaptive 2D gives none (recorded, not changed).
    expect(kernel.buildDepthLevels({ kind: 'fixed_step', topZ: 0, bottomZ: 0, stepdown: 1 }).levels).toEqual([0])
    expect(kernel.buildDepthLevels({ kind: 'adaptive_2d', topZ: 0, roughBottomZ: 0, stepdown: 1 }).levels).toEqual([])
  })

  it('agrees with today\'s Adaptive 3D restatement of the order (adaptive3dOperation.ts:332) on a grid', () => {
    const values = [-2, 0, 3, 5, 8]
    for (const clearanceZ of values) for (const retractZ of values) for (const feedZ of values) for (const top of [0, 3]) {
      let todayRefuses = false
      try {
        resolveAdaptive3dTraversePlanes({ resolvedHeights: { clearanceZ, retractZ, feedZ }, stockTopZ: top, partTopZ: top, materialTopZ: top })
      } catch (error) {
        todayRefuses = /must satisfy Clearance >= Retract >= Feed >= Material Start/.test((error as Error).message)
      }
      const kernelRefuses = kernel.safetyOrderViolation({ clearance: clearanceZ, retract: retractZ, feed: feedZ, top }) !== undefined
      expect(kernelRefuses, `${clearanceZ}/${retractZ}/${feedZ}/${top}`).toBe(todayRefuses)
    }
  })

  it('lifts a plane nobody set to the plane under it, and never lifts the operator\'s', () => {
    const floor = { wcsMm: 5, proofNodeIds: ['b'] }
    expect(kernel.liftUnsetPlane({ wcsMm: 2, proofNodeIds: ['a'] }, false, floor)).toEqual({ wcsMm: 5, proofNodeIds: ['a', 'b'] })
    expect(kernel.liftUnsetPlane({ wcsMm: 2, proofNodeIds: ['a'] }, true, floor)).toEqual({ wcsMm: 2, proofNodeIds: ['a'] })
    const lifted = both(faceIntent({ safety: { ...faceIntent().safety, feed: { reference: 'top', offsetMm: -1, owner: setupOwner } } }), context('face', faceEvidence()))
    expect(lifted.ok && lifted.plan.safety.feed.wcsMm).toBe(0)
    const operator = both(faceIntent({ safety: { ...faceIntent().safety, feed: { reference: 'top', offsetMm: -1, owner: userOwner } } }), context('face', faceEvidence()))
    expect(operator).toMatchObject({ ok: false, refusal: { code: 'invalid_plane_order' } })
  })
})

describe('WO-3020 precedence: user override > operation policy > setup default', () => {
  it('Top: the registered policy, then the operation\'s own start, then the operator\'s Top row', () => {
    const evidence = [...faceEvidence(-6, 0), node('feature-top', 'selected_feature', 'feature_top', -1)]
    const policy = both(faceIntent(), context('face', evidence))
    expect(policy.ok && policy.plan.machining.materialStart).toMatchObject({ wcsMm: 0, owner: policyOwner })

    const operation = both(faceIntent({ machining: { ...faceIntent().machining, start: { value: { kind: 'selected_feature_top' }, owner: policyOwner } } }),
      context('face', evidence))
    expect(operation.ok && operation.plan.machining.materialStart).toMatchObject({ wcsMm: -1, owner: policyOwner })

    const user = both(faceIntent({
      machining: { ...faceIntent().machining, start: { value: { kind: 'selected_feature_top' }, owner: policyOwner } },
      planeOverrides: { top: { reference: 'stock_top', offsetMm: -2, owner: userOwner } },
    }), context('face', evidence))
    expect(user.ok && user.plan.machining.materialStart).toMatchObject({ wcsMm: -2, owner: userOwner })
  })

  it('Bottom: the operator\'s Bottom row replaces the policy end and owns it', () => {
    const user = both(faceIntent({ planeOverrides: { bottom: { reference: 'stock_top', offsetMm: -4, owner: userOwner } } }), context('face', faceEvidence(-2)))
    expect(user.ok && user.plan.machining.cutterCenterEnd).toMatchObject({ wcsMm: -4, owner: userOwner })
    const policy = both(faceIntent(), context('face', faceEvidence(-2)))
    expect(policy.ok && policy.plan.machining.cutterCenterEnd).toMatchObject({ wcsMm: -2, owner: policyOwner })
  })

  it('safety planes: a setup default carries the setup owner; an operator plane carries user_override', () => {
    const plan = both(faceIntent({ safety: { ...faceIntent().safety, retract: { reference: 'wcs_plane', offsetMm: 20, owner: userOwner } } }), context('face', faceEvidence()))
    expect(plan.ok && plan.plan.safety).toMatchObject({
      retract: { wcsMm: 20, owner: userOwner }, clearance: { wcsMm: 30, owner: setupOwner }, feed: { wcsMm: 2, owner: setupOwner },
    })
  })
})

describe('WO-3020 policies at parity', () => {
  it('every carded flag is at its parity value and the service uses it', () => {
    expect(kernel.PARITY_POLICY).toEqual({
      top_source: 'stock_box_top', override_moves_formula: false, floor_allowance_rough_only: false, fixture_clearance: false,
    })
    expect(Object.isFrozen(kernel.PARITY_POLICY)).toBe(true)
    expect(Object.keys(kernel.CARDED_ALTERNATIVES).sort()).toEqual(Object.keys(kernel.PARITY_POLICY).sort())
    const service = kernel.createHeightsService()
    expect(service.policy).toBe(kernel.PARITY_POLICY)
    expect(service.resolve).toBe(kernel.resolveHeightPlan)
    // top_source = stock_box_top: the 3D rough's first level derives from the stock box top (RC-009).
    expect(service.roughLevelTopZ({ stockBoxTopZ: 12.5 })).toBe(12.5)
  })

  it('fixture_clearance off: no obstacle raises a plane; the plan says clearance is unverified, as today', () => {
    const plan = both(faceIntent(), context('face', faceEvidence()))
    expect(plan.ok && plan.plan.warnings).toEqual(['Fixture/clamp clearance is unverified.'])
  })
})

const root = process.cwd()
const rel = (path: string) => relative(root, path).split(sep).join('/')
const heightFiles = readdirSync(resolve('src/kernel/heights')).filter(name => name.endsWith('.ts')).map(name => resolve('src/kernel/heights', name))

function importsOf(path: string): string[] {
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) found.push(n.moduleSpecifier.text)
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) found.push('<dynamic>')
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) found.push(n.argument.literal.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

describe('WO-3020 headless, deterministic, kernel-only', () => {
  it('every heights file imports only its own directory and src/types (no viewport, UI, store or engine)', () => {
    const outside = heightFiles.flatMap(path => importsOf(path)
      .map(spec => [rel(path), spec, spec.startsWith('.') ? rel(resolve(dirname(path), spec)) : spec] as const)
      .filter(([, , target]) => !(target.startsWith('src/kernel/heights/') || target === 'src/types')))
    expect(outside).toEqual([])
  })

  it('the 3D lane adapters (builder.ts) reach only the kernel resolver: no heights file names today\'s smartHeights', () => {
    for (const path of heightFiles) expect(importsOf(path).filter(spec => /smartHeights|lib\/cam|cam3d/.test(spec)), rel(path)).toEqual([])
    expect(heightFiles.filter(path => /export function resolve\w*Plan\b/.test(readFileSync(path, 'utf8'))).map(rel))
      .toEqual(['src/kernel/heights/resolve.ts'])
  })

  it('reads no clock, randomness or global host object', () => {
    for (const path of heightFiles) {
      expect(readFileSync(path, 'utf8'), rel(path)).not.toMatch(/Date\.now|new Date|Math\.random|performance\.|window\.|document\.|globalThis|self\./)
    }
  })

  it('resolving twice gives byte-identical plans, levels and conversions', () => {
    const run = () => {
      const result = kernel.resolveHeightPlan(faceIntent(), context('face', faceEvidence(-3.3)))
      if (!result.ok) throw new Error(result.refusal.message)
      return JSON.stringify({
        plan: result.plan,
        worker: kernel.planToWorkerHeights(result.plan),
        local: kernel.planToLocalHeights(result.plan, { geometryPositionZ: 4, wcsOriginMachineMm: 100, stockTop: { kind: 'material_start' } }),
        levels: kernel.buildDepthLevels({ kind: 'even_3d', topZ: 0, bottomZ: -3.3, stepdown: 1, requiredDepths: [-1.5] }),
      })
    }
    expect(run()).toBe(run())
  })
})
