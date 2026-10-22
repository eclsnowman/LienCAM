// WO-3017 MD-45: one tool-shape source. Every form the kernel material service
// generates from the revolved profile is compared with the code that builds it
// today, through that code's own entry point:
//   drop-cutter spec  toolToCutterSpec          (src/cam3d/integration/cutterSpec.ts)
//   sweep profile     sweepProfile/profileHeight (src/cam3d/stock/cutterProfile.ts)
//   reach-trim bands  headBandsFor               (src/lib/cam/holderClearance.ts, module-private:
//                     its declaration is lifted from the source text and run as written)
//   simulation        tipOffsetAtRadius          (src/lib/tool/toolProfile.ts)
// Flat and ball must be identical (motion-neutral); bull-nose and V-bit are
// checked against today's spec and the analytic profile.
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { Tool, ToolType } from '../../types'
import { TOOL_TYPE_META, toolTypeMeta } from '../../lib/tool/toolMeta'
import { buildToolProfile, radiusAtZ, tipOffsetAtRadius, type ToolProfile } from '../../lib/tool/toolProfile'
import { toolToCutterSpec } from '../../cam3d/integration/cutterSpec'
import { profileHeight, sweepProfile } from '../../cam3d/stock/cutterProfile'
import type { CutterSpec } from '../../cam3d/kernel/types'
import {
  dropCutterSpec, reachBands, simulationBottomAt, sweepHeight, sweepShape, toolShape,
  type DropCutterSpec, type RevolvedProfile, type ToolShapeSource,
} from '../../kernel/material'
import { makeTool } from '../post/helpers'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
// The kernel mirrors cannot drift from the engine types: tsc -b fails if they do.
const typeChecks: [Equal<DropCutterSpec, CutterSpec>, Equal<keyof RevolvedProfile, keyof ToolProfile>] = [true, true]
const profileAssignable: RevolvedProfile = buildToolProfile(makeTool())

function source(tool: Tool): ToolShapeSource {
  return { tool, profileKind: toolTypeMeta(tool.type).profileKind, profile: buildToolProfile(tool) }
}

/** One record per type plus geometry variants for the four families today's spec models. */
function fixtureTools(): Tool[] {
  const tools: Tool[] = []
  let n = 0
  const add = (o: Partial<Tool>) => tools.push(makeTool({ id: `t${++n}`, name: `T${n}`, ...o }))
  for (const type of Object.keys(TOOL_TYPE_META) as ToolType[]) {
    add({ type, diameter: 6, fluteLength: 18, shankDiameter: 6, overallLength: 60, angleFromAxisDeg: 45, cornerRadius: 1 })
  }
  for (const d of [0.5, 2, 3, 3.175, 6, 6.35, 12.7, 25]) {
    add({ type: 'flat_end_mill', diameter: d, fluteLength: 3 * d, shankDiameter: Math.max(d, 3), overallLength: 50 })
    add({ type: 'ball_end_mill', diameter: d, fluteLength: 3 * d, shankDiameter: Math.max(d, 3), overallLength: 50 })
    add({ type: 'ball_end_mill', diameter: d, fluteLength: d / 4, shankDiameter: d, overallLength: 50 })
    add({ type: 'bull_nose', diameter: d, cornerRadius: d / 8, fluteLength: 3 * d, shankDiameter: d, overallLength: 50 })
    add({ type: 'bull_nose', diameter: d, cornerRadius: d / 2, fluteLength: 3 * d, shankDiameter: d, overallLength: 50 })
    add({ type: 'v_bit', diameter: d, angleFromAxisDeg: 30, fluteLength: 3 * d, shankDiameter: d, overallLength: 50 })
    add({ type: 'v_bit', diameter: d, angleFromAxisDeg: 45, tipDiameter: d / 10, fluteLength: 3 * d, shankDiameter: d, overallLength: 50 })
    add({ type: 'v_bit', diameter: d, angleFromAxisDeg: 59.5, fluteLength: d / 4, shankDiameter: d, overallLength: 50 })
  }
  add({ type: 'v_bit', diameter: 6, fluteLength: 10, shankDiameter: 6, overallLength: 50 }) // absent angle: 59 default
  add({ type: 'flat_end_mill', diameter: 4, fluteLength: 8, shankDiameter: 6, neckDiameter: 3.6, shoulderLength: 10, overallLength: 50 })
  add({ type: 'lollipop_mill', diameter: 6, fluteLength: 5, shankDiameter: 6, neckDiameter: 3, shoulderLength: 12, overallLength: 50 })
  add({ type: 'dovetail_mill', diameter: 10, fluteLength: 4, shankDiameter: 6, angleFromAxisDeg: 30, overallLength: 50 })
  add({ type: 'slitting_saw', diameter: 20, fluteLength: 1.5, shankDiameter: 6, neckDiameter: 8, overallLength: 50 })
  add({ type: 'thread_mill', diameter: 5, fluteLength: 8, shankDiameter: 6, neckDiameter: 3.5, threadPitch: 1, threadTeethCount: 4, overallLength: 50 })
  // Refused today: each must come back with today's exact line.
  add({ type: 'flat_end_mill', diameter: 0 })
  add({ type: 'ball_end_mill', diameter: Number.NaN })
  add({ type: 'bull_nose', diameter: 6, cornerRadius: undefined })
  add({ type: 'bull_nose', diameter: 6, cornerRadius: 3.5 })
  add({ type: 'v_bit', diameter: 6, angleFromAxisDeg: 90 })
  add({ type: 'v_bit', diameter: 6, angleFromAxisDeg: 45, tipDiameter: 6 })
  return tools
}

/** headBandsFor as holderClearance.ts declares it, lifted from the source and run unchanged. */
function todaysHeadBandsFor(): (tool: Tool, tol: number, slack: number, maxBand?: number) => { bottom: number; top: number; radius: number }[] {
  const path = 'src/lib/cam/holderClearance.ts'
  const text = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const decl = file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'headBandsFor')
  if (!decl) throw new Error('headBandsFor not found in holderClearance.ts')
  const js = ts.transpileModule(decl.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
  return new Function('buildToolProfile', `${js}\nreturn headBandsFor`)(buildToolProfile)
}

const radii = (R: number) => Array.from({ length: 401 }, (_, k) => (k / 400) * R * 1.1)

describe('WO-3017 one tool-shape source (MD-45)', () => {
  it('pins the kernel mirrors to the engine types', () => {
    expect(typeChecks).toEqual([true, true])
    expect(profileAssignable.vertices.length).toBeGreaterThan(1)
  })

  it('drop-cutter spec: equal to toolToCutterSpec on every fixture, refusals included', () => {
    const rows: string[] = []
    for (const tool of fixtureTools()) {
      let today: CutterSpec | { refused: string }
      try { today = toolToCutterSpec(tool) } catch (error) { today = { refused: (error as Error).message } }
      const generated = dropCutterSpec(source(tool))
      const mine = generated.ok ? generated.value : { refused: generated.reason }
      if ('refused' in today || 'refused' in mine || today.kind !== 'vbit' || mine.kind !== 'vbit') {
        if (JSON.stringify(mine) !== JSON.stringify(today)) rows.push(`${tool.name} ${tool.type}: ${JSON.stringify(mine)} != ${JSON.stringify(today)}`)
        continue
      }
      // V-bit: diameter and tip exact; the angle is read back from the cone's slope.
      const { angleFromAxisDeg: a, ...rest } = mine
      const { angleFromAxisDeg: b, ...restToday } = today
      if (JSON.stringify(rest) !== JSON.stringify(restToday) || Math.abs(a - b) > 1e-9) {
        rows.push(`${tool.name} v_bit: ${JSON.stringify(mine)} vs ${JSON.stringify(today)}`)
      }
    }
    expect(rows).toEqual([])
  })

  it('sweep profile: flat and ball equal today\'s sweepProfile/profileHeight exactly; bull and V-bit equal the analytic profile', () => {
    const rows: string[] = []
    let flatBall = 0, bull = 0, cone = 0
    for (const tool of fixtureTools()) {
      if (!['flat_end_mill', 'ball_end_mill', 'bull_nose', 'v_bit'].includes(tool.type)) continue
      let cutter: CutterSpec
      try { cutter = toolToCutterSpec(tool) } catch { continue }
      const shape = sweepShape(source(tool))
      if (!shape.ok) { rows.push(`${tool.name}: ${shape.reason}`); continue }
      const s = shape.value
      if (cutter.kind === 'flat' || cutter.kind === 'ball') {
        flatBall++
        const prof = sweepProfile(cutter)
        if (s.kind !== prof.kind || s.radius !== prof.radius) rows.push(`${tool.name}: ${s.kind}/${s.radius} vs ${prof.kind}/${prof.radius}`)
        for (const r of radii(prof.radius)) {
          if (!Object.is(sweepHeight(s, r), profileHeight(prof.kind, prof.radius, r))) rows.push(`${tool.name} r=${r}`)
        }
      } else if (cutter.kind === 'bull') {
        bull++
        const R = cutter.diameter / 2, c = cutter.cornerRadius
        if (s.kind !== 'bull') { rows.push(`${tool.name}: kind ${s.kind}`); continue }
        for (const r of radii(R)) {
          const truth = r > R ? Infinity : r <= R - c ? 0 : c - Math.sqrt(Math.max(0, c * c - (r - (R - c)) ** 2))
          const got = sweepHeight(s, r)
          if (!(got === truth || Math.abs(got - truth) <= 1e-9)) rows.push(`${tool.name} r=${r}: ${got} vs ${truth}`)
        }
      } else {
        cone++
        const R = cutter.diameter / 2, rt = (cutter.tipDiameter ?? 0) / 2, tan = Math.tan(cutter.angleFromAxisDeg * Math.PI / 180)
        if (s.kind !== 'cone') { rows.push(`${tool.name}: kind ${s.kind}`); continue }
        for (const r of radii(R)) {
          const truth = r > R ? Infinity : r <= rt ? 0 : (r - rt) / tan
          const got = sweepHeight(s, r)
          if (!(got === truth || Math.abs(got - truth) <= 1e-9 * Math.max(1, truth))) rows.push(`${tool.name} r=${r}: ${got} vs ${truth}`)
        }
      }
    }
    expect(rows).toEqual([])
    expect([flatBall, bull, cone].every(count => count >= 8)).toBe(true)
  })

  it('sweep profile: a shape with no analytic family sweeps inside the tool body and says so in one line', () => {
    const rows: string[] = []
    let inscribed = 0
    for (const tool of fixtureTools()) {
      const src = source(tool)
      if (['flat', 'ball', 'bull', 'cone'].includes(src.profileKind) || !(tool.diameter > 0)) continue
      const shape = sweepShape(src)
      // A record whose profile has no physical body (a dovetail whose taper closes past the axis) cannot be swept; one line says so.
      if (!shape.ok && src.profile.vertices.some(v => v.r < 0) && !shape.reason.includes('\n')) continue
      if (!shape.ok) { rows.push(`${tool.name} ${tool.type}: ${shape.reason}`); continue }
      const s = shape.value
      if (s.kind !== 'inscribed') { rows.push(`${tool.name}: ${s.kind}`); continue }
      inscribed++
      if (s.note.split('\n').length !== 1 || !s.note.includes(tool.type)) rows.push(`${tool.name}: note ${s.note}`)
      // Every point the sweep claims (height h at radius r) is inside the real tool: r <= radiusAtZ(h') for all h' >= h.
      const real = buildToolProfile(tool)
      const top = real.vertices[real.vertices.length - 1].z
      for (const r of radii(s.radius).filter(r => r <= s.radius)) {
        const h = sweepHeight(s, r)
        for (let k = 0; k <= 200; k++) {
          const z = h + (top - h) * (k / 200)
          if (radiusAtZ(real, z) < r - 1e-9) { rows.push(`${tool.name} r=${r} z=${z}`); break }
        }
      }
    }
    expect(rows).toEqual([])
    expect(inscribed).toBeGreaterThanOrEqual(8)
  })

  it('reach-trim bands: equal to today\'s headBandsFor on every fixture and parameter set', () => {
    const today = todaysHeadBandsFor()
    const rows: string[] = []
    let compared = 0
    for (const tool of fixtureTools()) {
      if (!(tool.diameter > 0)) continue
      for (const [tol, slack, maxBand] of [[0, 0, Infinity], [0, 0, 0.05], [0.05, 0.1414, 0.05], [0.2828, 0.1414, 0.2828]]) {
        compared++
        const mine = toolShape(source(tool)).reachBands(tol, slack, maxBand)
        if (JSON.stringify(mine) !== JSON.stringify(today(tool, tol, slack, maxBand))) rows.push(`${tool.name} ${tool.type} ${tol}/${slack}/${maxBand}`)
      }
    }
    expect(rows).toEqual([])
    expect(compared).toBeGreaterThan(200)
    expect(reachBands(buildToolProfile(makeTool()), 0, 0)).toEqual(today(makeTool(), 0, 0))
  })

  it('simulation profile: equal to today\'s tipOffsetAtRadius on every fixture', () => {
    const rows: string[] = []
    for (const tool of fixtureTools()) {
      if (!(tool.diameter > 0)) continue
      const profile = buildToolProfile(tool)
      for (const d of [-1, ...radii(tool.diameter / 2)]) {
        if (!Object.is(simulationBottomAt(profile, d), tipOffsetAtRadius(profile, d))) rows.push(`${tool.name} ${tool.type} d=${d}`)
      }
    }
    expect(rows).toEqual([])
  })

  it('is deterministic: two generations are identical', () => {
    const run = () => JSON.stringify(fixtureTools().map(tool => {
      const s = toolShape(source(tool))
      return [s.dropCutter, s.sweep, tool.diameter > 0 ? s.reachBands(0.05, 0.1, 0.05) : [], s.simulationBottomAt(1)]
    }))
    expect(run()).toBe(run())
  })
})
