// WO-464 - an unenterable re-seed sliver is honest residual, not an operation failure.

import { beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'

import {
  ensureEngineClipperReady,
  intersection,
  netArea,
  offsetClosed,
  type Loop,
} from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  getDroppedSliverStats,
  MIN_DESCENT_HELIX_RADIUS,
  processFeature,
  type Feature,
  type ProcessParams,
} from '../../lib/cam/adaptiveClearing2d/engine/processFeature'

const BEFORE_DUMP = 'src/tests/evidence/WO-458/sliver-picture/first-level-dump.json'

type SliverDump = {
  params: Feature
  toolParams: ProcessParams
  entries: { point: { x: number; y: number }; radius: number }[]
  cutRegion: Loop[]
  stats: { residualArea: number }
}

function area(loop: Loop): number {
  let twice = 0
  for (let i = 0; i < loop.length; i++) {
    const next = loop[(i + 1) % loop.length]
    twice += loop[i].x * next.y - next.x * loop[i].y
  }
  return Math.abs(twice / 2)
}

function circle(cx: number, cy: number, radius: number): Loop {
  return Array.from({ length: 64 }, (_, i) => {
    const angle = (i / 64) * Math.PI * 2
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
  })
}

function loadGtFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const data = JSON.parse(
    fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'),
  ) as { boundary: number[][]; islands?: number[][][]; helix?: { diameter?: number }; name: string }
  return {
    boundary: data.boundary.map(([x, y]) => ({ x, y })),
    holes: (data.islands ?? []).map(island => island.map(([x, y]) => ({ x, y }))),
    helixDiameter: data.helix?.diameter ?? 3,
    name: data.name,
  }
}

describe('WO-464 re-seed sliver buffer', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  // WO-465 moved WHEN this sliver is declined, not WHETHER. It is now refused at the
  // cut-region stage (it is never made a region at all); the buffer this file exists for
  // still catches the same component wherever prevention does not apply, and
  // preventSliver.wo465.test.ts holds that positive control. Every claim below is
  // unchanged: no entry the emitter would refuse, and the material honestly in residual.
  it('declines the diagnosed restWiring first-level sliver into honest residual', () => {
    const before = JSON.parse(fs.readFileSync(BEFORE_DUMP, 'utf8')) as SliverDump
    expect(before.entries.map(entry => entry.radius)).toEqual([1, 1, 1, 0.16077728271484393])

    // WO-1896: the dump was recorded on the material-left stream it labelled climb; the
    // rule now names that stream conventional, so replay it under that name.
    const result = processFeature(before.params, { ...before.toolParams, millingDirection: 'conventional' })
    const dropped = getDroppedSliverStats()
    const cutPasses = result.passes.filter(pass => pass.type === 'cut').length

    expect(result.entries).toHaveLength(3)
    // Seven old cut passes disappear when the un-emittable plunge's fake opened disk is no
    // longer credited. Pin the affected fixture's actual change; the no-sliver corpus is
    // byte-pinned below.
    // WO-1178 re-pin (84 -> 77 -> 50): honest seed credit and the walker planting starts
    // ahead of stock. Same three helix entries, same declined lens (0.2735 mm2, entry
    // radius 0.160778), residual reported honestly (205.60 -> 213.19 mm2: two slivers
    // under the completion bar, in `residual`). Disclosed on the WO-1178 picture card: one
    // landing on this fixture now descends by helix where main used a tangent lead.
    // WO-1178 attempt 3 re-pin (50 -> 45): tangent wall joins (arrival fillet, curvature-
    // limited departure lead) and one forward ride over overlapping cusp rides re-sequence
    // the rings; the same three helix entries, the same declined lens, and the residual is
    // reported honestly at 201.71 mm2 (was 213.19).
    // WO-1901 re-pin (45 -> 44). This dump has SEVERAL regions, and its rings used to be
    // ridden after the whole walk. They are ridden in each region before the tool leaves it
    // now, so one ring is reached as a wall-follow through-ride instead of a lead plus its
    // own cut pass. Measured on this exact fixture, with and without the change:
    //   passes 111 -> 106 (cut 45 -> 44, link 40 -> 38, lead 21 -> 18, wallfollow 1 -> 2),
    //   path length 1232.78 -> 1088.29 mm, residual 201.713762 mm2 IDENTICAL, same three
    //   entries, same declined lens, still not aborted. Less flying, same material.
    expect(cutPasses).toBe(44)
    expect(result.entries.every(entry => entry.radius >= MIN_DESCENT_HELIX_RADIUS)).toBe(true)
    // WO-465 re-cut: 0.16077728271484393 -> 0.160778125. The capacity search is a
    // measurement taken AFTER the decision, and it now runs over the isolated component
    // instead of the whole `remaining` set, so findStartPointIn's offset ladder starts from
    // a different bounding box. Same 0.1608 mm to six places, same verdict.
    expect(dropped.largestEntryRadius).toBeCloseTo(0.160778125, 9)
    expect(dropped.regions).toHaveLength(1)
    expect(dropped.regions[0].stage).toBe('cut-region')
    // The current engine's boolean rebuild differs from the preserved WO-458 dump by
    // 0.00002 mm2 at the polygon boundary; both resolve to the same 0.273 mm2 sliver.
    // WO-465 reads the component off cutRegion's own loops rather than re-deriving it
    // through materialComponents, which moves the same figure by a further 2e-5 mm2.
    expect(dropped.regions[0].toolCentreArea).toBeCloseTo(0.27348035, 4)
    expect(result.stats.residualArea).toBeGreaterThan(before.stats.residualArea)

    // Independent geometry check: the measurement record is exactly the physical material
    // in the final residual under the dropped tool-centre component's cutter-radius sweep.
    const sliver = before.cutRegion.slice().sort((a, b) => area(a) - area(b))[0]
    const swept = offsetClosed([sliver], before.toolParams.toolRadius, before.toolParams.arcTol)
    const sweptResidual = intersection(swept, result.residual)
    expect(dropped.regions[0].sweptArea).toBeCloseTo(Math.abs(netArea(sweptResidual)), 6)
    expect(dropped.regions[0].sweptArea).toBeGreaterThan(0)

    console.log(
      `[WO-464 restWiring level] entries ${before.entries.length}->${result.entries.length}; `
      + `cut-passes 84->${cutPasses}; `
      + `residual ${before.stats.residualArea.toFixed(6)}->${result.stats.residualArea.toFixed(6)} mm2; `
      + `dropped tool-centre=${dropped.regions[0].toolCentreArea.toFixed(6)} mm2, `
      + `swept-residual=${dropped.regions[0].sweptArea.toFixed(6)} mm2, `
      + `entry-r=${dropped.largestEntryRadius?.toFixed(6)} mm`,
    )
  })

  it('does not mistake a small configured helix for the remaining region capacity', () => {
    const before = JSON.parse(fs.readFileSync(BEFORE_DUMP, 'utf8')) as SliverDump
    const centreRegionAreas = before.cutRegion.map(area).sort((a, b) => b - a)
    expect(centreRegionAreas.slice(0, 3).every(regionArea => regionArea > 100)).toBe(true)

    const result = processFeature(before.params, { ...before.toolParams, helixDiameter: 0.2 })
    const cutPasses = result.passes.filter(pass => pass.type === 'cut').length

    // Attempt 1 read the requested 0.100 mm radius from `entry`, so it dropped the first
    // large re-seed and stopped after one entry. A second entry proves that configured
    // radius no longer stands in for the >100 mm2 remaining region's capacity.
    expect(result.entries.length).toBeGreaterThan(1)
    expect(result.entries[0].radius).toBeCloseTo(0.1, 10)
    expect(result.entries[1].radius).toBeCloseTo(0.1, 10)
    expect(cutPasses).toBeGreaterThan(1)
  })

  it('does not mistake a radius-zero plunge re-seed for the remaining region capacity', () => {
    const before = JSON.parse(fs.readFileSync(BEFORE_DUMP, 'utf8')) as SliverDump
    const first = before.entries[0].point

    // A radius-zero FIRST entry is outside this WO and correctly remains unchanged. Seed a
    // proven-clear first cutter disk so this case reaches the later interior re-seed path
    // with helixDiameter 0. Attempt 1 dropped that large region before recording a plunge.
    const result = processFeature(before.params, {
      ...before.toolParams,
      helixDiameter: 0,
      clearedSeed: [circle(first.x, first.y, before.toolParams.toolRadius + 0.2)],
    })
    const plungeReseeds = result.entries.filter(entry => entry.mode === 'plunge' && entry.radius === 0)

    expect(plungeReseeds).toHaveLength(2)
    // WO-1178 attempt 3 re-pin (> 50 -> > 40): 47 cut passes with the re-sequenced rings; the
    // claim is that the large region was roughed rather than dropped, which 47 still proves.
    expect(result.passes.filter(pass => pass.type === 'cut').length).toBeGreaterThan(40)
    // WO-1178 re-pin: a plunge seed keeps its disk until proven orphaned, so the SAME
    // 0.2735 mm2 lens the first case pins as correctly declined is now recorded once, at
    // the re-seed stage, instead of vanishing. One region, the known lens, not hidden.
    expect(getDroppedSliverStats().regions).toHaveLength(1)
  })

  it('does not drop a region where the exact 0.200 mm floor probe fits', () => {
    const before = JSON.parse(fs.readFileSync(BEFORE_DUMP, 'utf8')) as SliverDump
    const widened: Feature = {
      ...before.params,
      holes: (before.params.holes ?? []).map(loop => loop.map(point => (
        point.x === 31 ? { ...point, x: 30.93 } : point
      ))),
    }

    const result = processFeature(widened, before.toolParams)
    const boundaryReseed = result.entries[3]

    // The fallback entry and capacity estimate both report 0.195068 mm because the search
    // stops inside its 0.025 mm bracket. The gate's separate exact 0.200 mm probe fits, so
    // this fourth re-seed must survive even though the approximate value reads below floor.
    expect(result.entries).toHaveLength(4)
    expect(boundaryReseed.radius).toBeCloseTo(0.195068359375, 10)
    expect(boundaryReseed.radius).toBeLessThan(MIN_DESCENT_HELIX_RADIUS)
    expect(getDroppedSliverStats().regions).toHaveLength(0)
  })

  it('measures dropped swept material across the nine-shape climb corpus', () => {
    const rows: { fix: number; name: string; regions: number; sweptAreas: number[] }[] = []
    for (let fix = 0; fix <= 8; fix++) {
      const fixture = loadGtFixture(fix)
      const params: ProcessParams = {
        toolRadius: 2,
        stepOver: 0.4,
        tolerance: 0.1,
        helixDiameter: fixture.helixDiameter,
        stockToLeave: 0.5,
        millingDirection: 'climb',
        integralWallFollow: true,
        wallCleanupAsWeGo: true,
        loopbackFilletPct: 25,
        wallFinish: true,
      }
      const warn = console.warn
      console.warn = () => {}
      try {
        processFeature({ boundary: fixture.boundary, holes: fixture.holes }, params)
      } finally {
        console.warn = warn
      }
      const dropped = getDroppedSliverStats()
      expect(dropped.regions.every(region => region.toolCentreArea > 0 && region.sweptArea >= 0)).toBe(true)
      expect(dropped.largestEntryRadius === null || dropped.largestEntryRadius < MIN_DESCENT_HELIX_RADIUS).toBe(true)
      rows.push({
        fix,
        name: fixture.name,
        regions: dropped.regions.length,
        sweptAreas: dropped.regions.map(region => Number(region.sweptArea.toFixed(6))),
      })
    }

    expect(rows).toHaveLength(9)
    expect(rows.map(row => row.regions)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
    for (const row of rows) {
      console.log(
        `[WO-464 corpus] fix${row.fix} ${row.name}: dropped=${row.regions}; `
        + `swept-residual-mm2=${row.sweptAreas.length > 0 ? row.sweptAreas.join(',') : 'none'}`,
      )
    }
  }, 600_000)
})
