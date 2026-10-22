// WO-3018 acceptance 3 (UNIT + GOLD): the adaptive numeric policy record.
//
// Golden: the record's values equal today's engine numbers (copied from the WO-3018
// starter, 855ea4d9, by hand into GOLDEN below). Static check: every listed engine site now
// reads the record and the starter literal it replaced is gone (sites and their starter
// file:line in src/tests/evidence/WO-3018/policy-sites.json). The record is frozen, pure
// and carries both MD-119 candidate forms with the per-site parity form selected.
import { readFileSync, readdirSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { ADAPTIVE_OPERATION_RECORDS } from '../../kernel/ops/adaptive'
import {
  ADAPTIVE_POLICY, ADAPTIVE_POLICY_SOURCES, ADAPTIVE_POLICY_VERSION, adaptiveEngageMoveDistance,
} from '../../kernel/ops/adaptive/policy'

const ENGINE = 'src/lib/cam/adaptiveClearing2d/engine/'
const SITES = JSON.parse(readFileSync('src/tests/evidence/WO-3018/policy-sites.json', 'utf8')) as {
  starter: string
  sites: { key: string; file: string; starterLines: number[]; before: string; after: string; count: number; liveCount?: number; liveNote?: string }[]
}

const GOLDEN = {
  version: 'adaptive-policy/1',
  defaults: { helixDiameterPctOfTool: 90, minHelixRadiusMm: 0.2, toleranceMm: 0.02, stepoverFraction: 0.4,
    stepoverMin: 0.01, stepoverMax: 0.95, rampAngleDeg: 3, loopbackFilletPct: 25 },
  sampling: { arcTolFraction: 0.25, arcTolFloorMm: 0.01, pathCleanTolerances: 0.25, seedSearchTolerances: 0.5,
    cycleCellTolerances: 2, cycleCellArcTols: 4, rideResampleMm: 0.75, rideWindowMm: 2, maxPriorMotionSamples: 4000,
    chordFloorMm: 0.05, maxArcSegments: 128, wallTolArcTols: 4, wallTolToolRadii: 0.05, searchResolutionFloorMm: 0.05,
    residualSearchToolRadii: 1.5, slideStepArcTols: 4, slideStepStepoverDivisor: 4, startSearchStepDivisor: 4,
    clearAirSpacingToolRadii: 0.25, cutAreaCacheQuantMm: 0.001, cutAreaBoundHalfRadii: 4, cutAreaBoundMarginRadii: 2,
    minStepdownMm: 0.1, maxDepthLevels: 2000, finishLeadFitSamples: 8 },
  steering: { maxDeflectionDivisor: 4, maxIterations: 12, maxErrorRel: 0.05, historyLen: 10, loadSetpoint: 0.95,
    millingSideDeadband: 0.2, headingSamples: 5, minCutDivisor: 3, boundaryTaperRadii: 2, nearStepTolerances: 2,
    turnStepTolerances: 0.5, straightStepTolerances: 4, minStepTolerances: 2, maxStepRadiusDivisor: 2,
    orbitCloseTolerances: 2, orbitCloseSteps: 1.5, orbitCloseStepovers: 2, orbitCloseDot: 0.5, maxPasses: 5000,
    maxPointsPerPass: 20000, maxUnsafeStarts: 32, maxOverCutStreak: 5, endOverlapStepovers: 0.8 },
  sharpening: { wallFilletMinRadiusDivisor: 4, wallFilletMinTurnDeg: 5, wallFilletLadderDivisors: [1, 2, 4],
    departReachRadii: 1.5, cornerMinTurnDivisor: 18, cornerDiskBandDepths: 4, loopbackPctLadder: [1, 0.5, 0.25, 0.125],
    loopbackMaxArcSweepDeg: 185, loopbackReversalDeg: 175, rideOverlapFilletRadii: 1.5, rideMinMm: 3,
    rideMaxPerimeterFraction: 0.25, rideClampMarginMm: 0.02, loopbackMinRadiusMm: 0.05, loopbackChordFloorMm: 0.005,
    loopbackChordRadii: 0.0015, loopbackMaxKinkDeg: 45, loopbackRideFraction: 0.9, loopbackMaxTurnDeg: 181,
    loopbackRadiusLadder: [1, 0.5, 0.25, 0.1], straightJoinTurnDeg: 0.5, straightJoinStubGapFraction: 0.25,
    straightJoinStubMaxMm: 0.5, joinTangentSlackGapFraction: 0.1, joinTangentSlackMm: 0.05, joinSweepToleranceDeg: 2,
    finishLeadMaxSweepDivisor: 2 },
  caps: { rideCapStepovers: 1.5, slotCeilingDiameters: 0.75, cutThroughOptimalMultiple: 2, rideOverLenMaxMm: 2,
    emptyRideAreaTolerances: 2, engageBandBiteFactor: 1.5, walkerMinBiteFraction: 0.02, minPassBiteRatio: 0.25,
    engageProtrusionStepovers: 0.1, engageRejectAreaMultiple: 2, landingUncutCap: 0.05, sideReseedClearUncutMax: 0.005,
    minLandingRideLenMm: 0.5, liftDistanceMm: 2, keepToolDownDistRatio: 3, integralWallFollowLengthFactor: 2,
    floorHopFallbackBandMm: 0.1, workholdingIslandMarginMm: 0.05 },
  helix: { minDescentRadiusMm: 0.2, fitEpsMm: 0.01, angularStepDivisor: 16, edgeBackoffMm: 0.01, maxPoints: 5000,
    minRadiusFraction: 0.5, minAngleDeg: 1 },
  traverseCap: { form: 'per-site', stepoverDivisor: 4,
    candidates: { 'S/4 + a': { arcTolMultiple: 1 }, 'S/4 + 4a': { arcTolMultiple: 4 } } },
}

function leaves(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key))
  }
  return [prefix]
}
const groupKeys = (keys: string[]) => keys.map(key => key.split('.').slice(0, 2).join('.'))

describe('WO-3018 adaptive numeric policy record', () => {
  it('holds exactly today\'s numbers (golden)', () => {
    expect(ADAPTIVE_POLICY).toEqual(GOLDEN)
    expect(ADAPTIVE_POLICY.version).toBe(ADAPTIVE_POLICY_VERSION)
  })

  it('is frozen all the way down and the module holds no mutable state', () => {
    const frozen = (value: unknown): boolean => !value || typeof value !== 'object'
      || (Object.isFrozen(value) && Object.values(value).every(frozen))
    expect(frozen(ADAPTIVE_POLICY)).toBe(true)
    expect(frozen(ADAPTIVE_OPERATION_RECORDS)).toBe(true)
    expect(() => { (ADAPTIVE_POLICY.caps as { rideCapStepovers: number }).rideCapStepovers = 2 }).toThrow(TypeError)
    for (const path of ['src/kernel/ops/adaptive/policy.ts', 'src/kernel/ops/adaptive/index.ts']) {
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      const mutable = source.statements.filter(statement => ts.isVariableStatement(statement)
        && !(statement.declarationList.flags & ts.NodeFlags.Const))
      expect(mutable.map(statement => statement.getText()), path).toEqual([])
      const imports = source.statements.filter(ts.isImportDeclaration).filter(statement => !statement.importClause?.isTypeOnly)
        .map(statement => (statement.moduleSpecifier as ts.StringLiteral).text)
      expect(imports, path).toEqual(path.endsWith('index.ts') ? ['./policy'] : [])
    }
  })

  it('names the engine file:line every value came from', () => {
    const recordKeys = groupKeys(leaves(ADAPTIVE_POLICY).filter(key => key !== 'version'))
    expect(Object.keys(ADAPTIVE_POLICY_SOURCES).sort()).toEqual([...new Set(recordKeys)].sort())
    for (const [key, sources] of Object.entries(ADAPTIVE_POLICY_SOURCES)) {
      expect(sources.length, key).toBeGreaterThan(0)
      for (const source of sources) expect(source, key).toMatch(/^[A-Za-z]+\.ts:\d+$/)
    }
    // Every site's starter lines are listed under each key it reads.
    for (const site of SITES.sites) {
      expect(site.starterLines.length, site.before).toBe(site.count)
      for (const key of new Set([site.key, ...[...site.after.matchAll(/AP\.([a-zA-Z]+\.[a-zA-Z]+)/g)].map(match => match[1])])) {
        for (const line of site.starterLines) {
          expect(ADAPTIVE_POLICY_SOURCES[key], key).toContain(`${site.file.slice(ENGINE.length)}:${line}`)
        }
      }
    }
  })

  it('the engine reads every listed number from the record (static check)', () => {
    const files = new Map(readdirSync(ENGINE).filter(name => name.endsWith('.ts'))
      .map(name => [ENGINE + name, readFileSync(ENGINE + name, 'utf8')]))
    const policyKeys = new Set(groupKeys(leaves(ADAPTIVE_POLICY)))
    for (const site of SITES.sites) {
      const text = files.get(site.file)!
      expect(text, site.file).toBeDefined()
      expect(text.split(site.before).length - 1, `starter literal still in ${site.file}: ${site.before}`).toBe(0)
      // A later landing may fold starter sites into one shared read (liveCount, with the reason in liveNote);
      // the starter literal must still be gone and the record must still be read there.
      if (site.liveCount !== undefined) expect(site.liveNote, `${site.key}: liveCount needs its reason`).toBeTruthy()
      expect(text.split(site.after).length - 1, `${site.file}: ${site.after}`).toBeGreaterThanOrEqual(site.liveCount ?? site.count)
      for (const match of site.after.matchAll(/AP\.([a-zA-Z]+\.[a-zA-Z]+)/g)) expect(policyKeys.has(match[1]), match[1]).toBe(true)
    }
    // Each engine file that reads the record imports it from the kernel's pure policy module.
    for (const [path, text] of files) {
      if (!/\bAP\./.test(text)) continue
      expect(text, path).toMatch(/import \{ ADAPTIVE_POLICY as AP(, adaptiveEngageMoveDistance)? \} from '\.\.\/\.\.\/\.\.\/\.\.\/kernel\/ops\/adaptive\/policy'/)
    }
    expect(SITES.sites.reduce((sum, site) => sum + site.count, 0)).toBeGreaterThanOrEqual(150)
  })

  it('carries both MD-119 cap forms; per-site parity keeps today\'s two expressions', () => {
    const samples = [[2.4, 0.02, 0.01], [1.6, 0.05, 0.0125], [3.3, 0.1, 0.025], [0.7, 0.013, 0.01]]
    for (const [stepOver, tolerance, arcTol] of samples) {
      expect(adaptiveEngageMoveDistance('walker', stepOver, tolerance, arcTol)).toBe(stepOver / 4 + tolerance)
      expect(adaptiveEngageMoveDistance('traverse', stepOver, undefined, arcTol)).toBe(stepOver / 4 + arcTol * 4)
      for (const [form, multiple] of [['S/4 + a', 1], ['S/4 + 4a', 4]] as const) {
        const policy = { ...ADAPTIVE_POLICY, traverseCap: { ...ADAPTIVE_POLICY.traverseCap, form } }
        expect(adaptiveEngageMoveDistance('walker', stepOver, tolerance, arcTol, policy)).toBe(stepOver / 4 + arcTol * multiple)
        expect(adaptiveEngageMoveDistance('traverse', stepOver, undefined, arcTol, policy)).toBe(stepOver / 4 + arcTol * multiple)
      }
    }
  })
})
