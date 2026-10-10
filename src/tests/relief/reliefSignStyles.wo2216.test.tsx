// @vitest-environment jsdom
//
// WO-2216 - the Height row's three buttons (Operator's card, Q-RELIEF-NAME-THE-
// THREE-SIGN-STYLE-1790700282896): Raise / Emboss / Engrave, through the
// production palette on the text sign fixture. Each button sets direction +
// emboss (reliefHeights.ts reliefStyleOf/reliefStyleSettings) and leaves
// Invert alone, so whichever button is active still means subject-relative:
//   - Raise:   the letters stand proud of the face, the background stays at it.
//   - Emboss:  the letters stay at the face, the background cuts to the depth.
//   - Engrave: the letters cut into the face to the depth, the background stays at it.
// The rail (useReliefSession railSections) and the palette (ReliefPanel) read
// the same store, so they must show the same active button.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytes.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
  computeStepSha256: vi.fn(async () => null),
}))
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { resetDocumentHolder } from '../../doc/documentHolder'
import { createLocalGeomService, GeomEngine } from '../../geom'
import { useCamStore } from '../../store'
import { useReliefStore } from '../../components/model3d/relief/reliefStore'
import { reliefSampler, type ReliefSettings, type ReliefStyle } from '../../relief/reliefHeights'
import { createFakeSceneRuntime, type FakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from '../model3d/loadTolerantWaitFor'

const TEXT_SIGN = resolve(process.cwd(), 'docs/design/relief-references/fixtures/fixture-03-text-sign.png')
const PLATE = { x: 100, y: 70, z: 15 }

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function clickWorld(runtime: FakeSceneRuntime, origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }): void {
  runtime.rayOverride = { origin, direction }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
}

let plateStep: ArrayBuffer

beforeAll(async () => {
  // the plate the operator imports: a 100 x 70 x 15 box as a STEP file
  const engine = new GeomEngine()
  await engine.init()
  const box = await engine.makeBox('PLATE', PLATE)
  plateStep = await engine.exportStep([box.body!])
  await engine.disposeKernel()
}, 120_000)

beforeEach(() => {
  stepBytes.clear()
  resetDocumentHolder()
  useReliefStore.getState().closeSession()
  vi.stubGlobal('alert', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetDocumentHolder()
})
afterAll(() => { useReliefStore.getState().closeSession() })

async function openTextSign(): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  useCamStore.getState().newProject()
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  fireEvent.change(screen.getByTestId('workbench-import-step-input'), { target: { files: [new File([plateStep], 'plate.step')] } })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 30_000 })
  clickWorld(runtime, { x: 50, y: 35, z: 100 }, { x: 0, y: 0, z: -1 })
  fireEvent.click(screen.getByTestId('workbench-relief'))
  await waitFor(() => expect(useReliefStore.getState().target?.ownerId).toBe('IMP1'), { timeout: 20_000 })
  const png = readFileSync(TEXT_SIGN)
  fireEvent.change(screen.getByTestId('relief-file-input'), { target: { files: [new File([png], 'fixture-03-text-sign.png', { type: 'image/png' })] } })
  await waitFor(() => expect(useReliefStore.getState().settings).not.toBeNull(), { timeout: 20_000 })
  return runtime
}

/** Wait for the applied-surface preview to settle again (bumpSettled), whatever changed. */
async function settleAfter(change: () => void): Promise<void> {
  const before = useReliefStore.getState().settledVersion
  change()
  await waitFor(() => expect(useReliefStore.getState().settledVersion).toBeGreaterThan(before), { timeout: 20_000 })
}

/** Every control the three buttons must NOT touch (rule 5's "any other palette change" is a FAIL). */
function otherControls(s: ReliefSettings) {
  // + 0 turns a stray -0 (Math.max(-0, 0) etc.) into 0, so toEqual doesn't trip on signed-zero noise
  return { invert: s.invert, widthMm: s.widthMm, heightMm: s.heightMm, zeroPlane: s.zeroPlane + 0, baseMm: s.baseMm + 0, depthMm: s.depthMm + 0 }
}

describe('WO-2216 relief Height row: Raise / Emboss / Engrave', () => {
  it('each button puts the letters and background at the height its name promises; rail and palette agree; nothing else in the palette changes', async () => {
    await openTextSign()
    // S6: Auto flipped the black-on-white art so the letters rise (reliefMode.test.tsx pins this same default)
    expect(useReliefStore.getState().settings).toMatchObject({ direction: 'raise', invert: true })
    await waitFor(() => expect(window.__reliefSettled?.()).not.toBeNull(), { timeout: 20_000 })

    const picture = useReliefStore.getState().picture!
    const initial = window.__reliefSettled!()!
    const before = otherControls(initial.settings)

    // locate the darkest (letter ink) and brightest (background) pixel of the adjusted picture once - Adjust
    // does not depend on direction/invert/emboss, so the same two pixels serve every button below
    let letterPx = 0, bgPx = 0
    for (let i = 1; i < initial.adjusted.length; i++) {
      if (initial.adjusted[i] < initial.adjusted[letterPx]) letterPx = i
      if (initial.adjusted[i] > initial.adjusted[bgPx]) bgPx = i
    }
    const fxfyOf = (idx: number) => {
      const px = idx % picture.cols, py = Math.floor(idx / picture.cols)
      return { fx: (px + 0.5) / picture.cols, fy: 1 - (py + 0.5) / picture.rows }
    }
    const letter = fxfyOf(letterPx)
    const bg = fxfyOf(bgPx)

    function heightsFor(): { letterMm: number; bgMm: number } {
      const settled = window.__reliefSettled!()!
      const at = reliefSampler(settled.adjusted, picture.cols, picture.rows, settled.settings)
      return { letterMm: at(letter.fx, letter.fy), bgMm: at(bg.fx, bg.fy) }
    }

    function activeIn(testId: string): boolean {
      const el = screen.getByTestId(testId)
      return el.getAttribute('aria-pressed') === 'true' || el.className.includes('active')
    }

    function expectActive(style: ReliefStyle): void {
      const other: ReliefStyle[] = (['raise', 'emboss', 'engrave'] as const).filter((s) => s !== style)
      expect(activeIn(`relief-dir-${style}`)).toBe(true)
      expect(activeIn(`relief-${style}`)).toBe(true)
      for (const o of other) {
        expect(activeIn(`relief-dir-${o}`)).toBe(false)
        expect(activeIn(`relief-${o}`)).toBe(false)
      }
    }

    const TOL = 0.1 // mm - Auto's 0.15 mm smooth softens the exact picture extreme a little

    // Raise (today's default for this fixture): letters proud at +depth, background at the face
    expectActive('raise')
    const depthMm = initial.settings.depthMm
    const raiseH = heightsFor()
    expect(raiseH.letterMm).toBeGreaterThan(depthMm - TOL)
    expect(Math.abs(raiseH.bgMm)).toBeLessThan(TOL)
    console.log('WO-2216 Raise heights (mm):', JSON.stringify(raiseH))

    // Emboss: letters stay at the face, background cuts down to the depth
    await settleAfter(() => fireEvent.click(screen.getByTestId('relief-dir-emboss')))
    expect(otherControls(window.__reliefSettled!()!.settings)).toEqual(before)
    expectActive('emboss')
    const embossH = heightsFor()
    expect(Math.abs(embossH.letterMm)).toBeLessThan(TOL)
    expect(embossH.bgMm).toBeLessThan(-(depthMm - TOL))
    console.log('WO-2216 Emboss heights (mm):', JSON.stringify(embossH))

    // Engrave (today's Cut in, renamed): letters cut in to the depth, background stays at the face
    await settleAfter(() => fireEvent.click(screen.getByTestId('relief-dir-engrave')))
    expect(otherControls(window.__reliefSettled!()!.settings)).toEqual(before)
    expectActive('engrave')
    const engraveH = heightsFor()
    expect(engraveH.letterMm).toBeLessThan(-(depthMm - TOL))
    expect(Math.abs(engraveH.bgMm)).toBeLessThan(TOL)
    console.log('WO-2216 Engrave heights (mm):', JSON.stringify(engraveH))

    // back to Raise through the rail this time: round-trips exactly (Invert was never touched)
    await settleAfter(() => fireEvent.click(screen.getByTestId('relief-raise')))
    expect(otherControls(window.__reliefSettled!()!.settings)).toEqual(before)
    expectActive('raise')
    const raiseAgain = heightsFor()
    expect(Math.abs(raiseAgain.letterMm - raiseH.letterMm)).toBeLessThan(1e-6)
    expect(Math.abs(raiseAgain.bgMm - raiseH.bgMm)).toBeLessThan(1e-6)
  }, 240_000)
})
