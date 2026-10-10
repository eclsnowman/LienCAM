// WO-2229 - a step level's edge sits at the picture's true outline (Operator
// 2026-09-29, card Q-RELIEF-EMBOSS-WITH-STEP-DOWNS-LO: "Fix it - level edge at
// the true outline"). Each value stands on its NEAREST floor: a level's edge is
// halfway between the floors on either side of it (Levels 1: half grey). Before
// it the edge was the value just above the floor below, so a soft letter edge
// was a whole level and Emboss + Levels 1 cut away the text sign's small line
// and frame even at vertical walls.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { capPicture, decodePng } from '../../relief/picture'
import { autoAdjust, autoParams } from '../../relief/adjust'
import {
  DEFAULT_STEPS, defaultSettings, heightOfValue, reliefStyleSettings, stepPlan, type FaceFrame, type ReliefSettings, type ReliefStyle, type StepDowns,
} from '../../relief/reliefHeights'
import { reliefKernelFields } from '../../relief/reliefFeature'

const steps = (patch: Partial<StepDowns>): StepDowns => ({ ...DEFAULT_STEPS, ...patch })

const BASE: ReliefSettings = {
  widthMm: 100, heightMm: 5, keepProportions: false, rotationDeg: 0, offsetXMm: 0, offsetYMm: 0,
  depthMm: 4, direction: 'raise', invert: false, zeroPlane: 0, baseMm: 0, auto: false,
}

describe('WO-2229 each value stands on its nearest floor', () => {
  it('Levels 1: 0.49 of the range stays on the face, 0.51 is on the floor - Raise, Engrave and Emboss', () => {
    const one = steps({ mode: 'levels', levels: 1 })
    const raise = heightOfValue({ ...BASE, steps: one })
    expect(raise(0.49)).toBe(0)
    expect(raise(0.51)).toBe(4)
    const engrave = heightOfValue({ ...BASE, direction: 'cut', steps: one })
    expect(engrave(0.49)).toBe(-0)
    expect(engrave(0.51)).toBe(-4)
    // Emboss mirrors: the subject (high values) at the face, the rest at the depth - its edge the same half grey
    const emboss = heightOfValue({ ...BASE, direction: 'cut', emboss: true, steps: one })
    expect(emboss(0.51)).toBe(-0)
    expect(emboss(0.49)).toBe(-4)
    // at or below the zero plane is still on the face
    expect(raise(0)).toBe(0)
  })

  it('Levels 4 of 4 mm: 0.1 / 0.2 / 0.9 land on floors 0 / 1 / 4', () => {
    const h = heightOfValue({ ...BASE, steps: steps({ mode: 'levels', levels: 4 }) })
    expect([0.1, 0.2, 0.9].map(h)).toEqual([0, 1, 4])
  })

  it('fixed 3 mm steps of a 9 mm depth: 1.4 -> 0, 1.6 -> 3, 7.4 -> 6, 7.6 -> 9 mm', () => {
    const h = heightOfValue({ ...BASE, depthMm: 9, steps: steps({ mode: 'step', stepMm: 3 }) })
    expect([1.4, 1.6, 7.4, 7.6].map((mm) => h(mm / 9))).toEqual([0, 3, 6, 9])
  })

  it('the floors themselves are unchanged', () => {
    expect(stepPlan({ depthMm: 4, steps: steps({ mode: 'levels', levels: 4 }) })!.floorsMm).toEqual([0, 1, 2, 3, 4])
    expect(stepPlan({ depthMm: 10, steps: steps({ mode: 'step', stepMm: 3 }) })!.floorsMm).toEqual([0, 3, 6, 9, 10])
  })
})

describe('WO-2229 the text sign keeps its small text and frame on Emboss, Levels 1, Walls 90', () => {
  // the WO-2226 capture's setup through the production open + Apply route: the text sign on a 100 x 70 mm plate's top
  // face (fitted 90 x 45 mm, Auto), the picture decoded and capped as the relief worker's open does
  const FIXTURE = path.resolve(__dirname, '../../../docs/design/relief-references/fixtures/fixture-03-text-sign.png')
  const pic = capPicture(decodePng(new Uint8Array(readFileSync(FIXTURE)))!)
  const auto = autoParams(pic)
  const face: FaceFrame = { centre: { x: 0, y: 0, z: 15 }, xDir: { x: 1, y: 0, z: 0 }, yDir: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 }, widthMm: 100, heightMm: 70 }
  const opened: ReliefSettings = { ...defaultSettings(pic, face, auto), adjust: autoAdjust(pic, auto) }

  /** The applied height grid (the mesh relief's working grid) for a style at Levels 1, Walls 90. */
  function grid(style: ReliefStyle) {
    const settings: ReliefSettings = { ...opened, ...reliefStyleSettings(style), steps: steps({ mode: 'levels', levels: 1, wallDeg: 90 }) }
    const d = reliefKernelFields(pic, { face, settings, autoParams: auto }).detail
    expect(d).toBeDefined()
    return { g: d!, settings }
  }
  /** Grid row through picture row `pr` (grid row 0 is the picture's bottom edge); cells between picture columns c0..c1. */
  const rowCells = (g: { cols: number; rows: number; heights: Float32Array }, pr: number, c0: number, c1: number) => {
    const r = Math.round((1 - (pr + 0.5) / pic.rows) * (g.rows - 1))
    const out: number[] = []
    for (let c = Math.ceil((c0 / pic.cols) * (g.cols - 1)); c <= Math.floor((c1 / pic.cols) * (g.cols - 1)); c++) out.push(g.heights[r * g.cols + c])
    return out
  }
  // the fixture (1600 x 800): the small line "EST. 2026 - FINE TEXT" spans x 335 .. 1270 around y 612; the frame's
  // bottom line runs y 738 .. 760, its left line x 40 .. 65
  const SMALL_ROW = 612, SMALL_X0 = 335, SMALL_X1 = 1270

  it('Emboss: the small text line and the frame line stand at the face', () => {
    const { g, settings } = grid('emboss')
    expect(settings.invert).toBe(true)
    const depth = settings.depthMm
    // Emboss: the subject (the black letters) stays at the face (0), the background is cut to the depth
    const small = rowCells(g, SMALL_ROW, SMALL_X0, SMALL_X1)
    const smallFace = small.filter((h) => h > -depth / 2).length
    const frameBottom = rowCells(g, 749, 200, 1400)
    const frameFace = frameBottom.filter((h) => h > -depth / 2).length
    // down the frame's left line, in the rows between the big letters and the small text
    const leftCol = Math.round((52.5 / pic.cols) * (g.cols - 1))
    let leftFace = 0, leftCells = 0
    for (let r = 0; r < g.rows; r++) {
      const pr = (1 - r / (g.rows - 1)) * pic.rows
      if (pr < 150 || pr > 650) continue
      leftCells++
      if (g.heights[r * g.cols + leftCol] > -depth / 2) leftFace++
    }
    console.log(`WO-2229 text sign Emboss L1 W90: small-text row ${smallFace} / ${small.length} face cells, frame bottom ${frameFace} / ${frameBottom.length}, frame left ${leftFace} / ${leftCells}`)
    expect(smallFace).toBeGreaterThan(0.2 * small.length)
    expect(frameFace).toBe(frameBottom.length)
    expect(leftFace).toBe(leftCells)
  })

  it('Raise: the same letters stand up, no fatter than Emboss keeps them - the small text and the frame line raised, the background on the face', () => {
    const { g, settings } = grid('raise')
    const small = rowCells(g, SMALL_ROW, SMALL_X0, SMALL_X1)
    const smallUp = small.filter((h) => h > settings.depthMm / 2).length
    // both edges are the same half-grey outline, so Raise's raised cells are Emboss's face cells (main: 451 vs 0)
    const e = grid('emboss')
    expect(smallUp).toBe(rowCells(e.g, SMALL_ROW, SMALL_X0, SMALL_X1).filter((h) => h > -e.settings.depthMm / 2).length)
    const frameBottom = rowCells(g, 749, 200, 1400)
    // the background between the lines is flat on the face
    const background = rowCells(g, 520, 200, 1400)
    console.log(`WO-2229 text sign Raise L1 W90: small-text row ${smallUp} / ${small.length} raised cells, frame bottom ${frameBottom.filter((h) => h > 0).length} / ${frameBottom.length}`)
    expect(smallUp).toBeGreaterThan(0.2 * small.length)
    expect(frameBottom.every((h) => h === settings.depthMm)).toBe(true)
    expect(background.every((h) => h === 0)).toBe(true)
  })
})
