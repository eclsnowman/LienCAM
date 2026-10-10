// WO-1492: BUG-386 (.sketch-empty-hint) and BUG-388 (.sketch-confirm-overlay,
// Circular Pattern) are the same "one-line, centered, never-wraps" overlay
// strip pattern with no max-width, so their content and controls can run off
// both edges of the workview. `.workbench-confirm-bar` already proved the
// fix (max-width clamp, app.css:8988); this file proves it now applies to
// both siblings too.
//
// jsdom never lays out (WO-119: "every layout claim in this project has
// been a stored number with hashes around it"), so the only real evidence
// that every control's bounding box sits inside the workview is a real
// browser measurement. On a normal `npx vitest run src/tests/ui` this starts
// a Vite dev server on THIS worktree, drives Chromium against it, and
// measures the two strips' real boxes. Nothing here reads a committed
// number. ONE MECHANISM, NOT TWO: the server boot, the page navigation and
// the measurement are imported from `src/tests/evidence/WO-1492/capture.mjs`
// -- the same code the CLI screenshot capture uses.
//
// A BROKEN HARNESS IS NOT A GREEN BRANCH AND NOT A RED ONE. If the dev
// server or the browser cannot start, every assertion below fails with an
// INCONCLUSIVE (infrastructure) message rather than passing or being
// skipped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
// Imported by URL: a bare .mjs import has no declaration file and fails `tsc -b` (TS7016).
const { SCENARIOS, runScenario, startDevServer } = await import(new URL('../evidence/WO-1492/capture.mjs', import.meta.url).href)

type DevServer = Awaited<ReturnType<typeof startDevServer>>

/** Vite cold-starts this app (three.js, occt-wasm) plus a Chromium page boot. */
const BOOT_TIMEOUT_MS = 300_000

interface Box { x: number; y: number; width: number; height: number }
interface Shot {
  name: string
  viewport: { width: number; height: number }
  pageErrors: string[]
  measurement: {
    workview: Box | null
    strip: Box | null
    controls: { name: string; box: Box | null }[]
  }
}

let infrastructure: string | null = null
const shots: Shot[] = []
let elapsedMs = 0

/**
 * The infrastructure gate every assertion in this file goes through.
 * Deliberately throws instead of skipping, so a missing browser cannot paint
 * a green slice for a strip that was never measured.
 */
function requireLive(): void {
  if (infrastructure) {
    throw new Error(
      `INCONCLUSIVE (infrastructure, not this branch): the overlay-strip clamp was NEVER ` +
        `MEASURED, so this run proves nothing about the layout either way. ${infrastructure}`,
    )
  }
  if (shots.length !== SCENARIOS.length) {
    throw new Error(`measured ${shots.length} scenarios, expected ${SCENARIOS.length}`)
  }
}

function shotFor(name: string): Shot {
  const shot = shots.find((s) => s.name === name)
  if (!shot) throw new Error(`no live measurement for ${name}`)
  return shot
}

/** True if `box` sits wholly inside `bounds` (a small rounding slack for real-browser subpixel layout). */
function isInside(box: Box, bounds: Box, slack = 0.75): boolean {
  return (
    box.x >= bounds.x - slack &&
    box.y >= bounds.y - slack &&
    box.x + box.width <= bounds.x + bounds.width + slack &&
    box.y + box.height <= bounds.y + bounds.height + slack
  )
}

/** True if every box's vertical center sits within `slack` of the first -- i.e. one row, not wrapped. */
function allSameRow(boxes: Box[], slack = 6): boolean {
  const centers = boxes.map((b) => b.y + b.height / 2)
  return centers.every((c) => Math.abs(c - centers[0]) <= slack)
}

beforeAll(async () => {
  const startedAt = Date.now()
  let server: DevServer | undefined
  let browser: Browser | undefined

  try {
    try {
      server = await startDevServer()
    } catch (error) {
      infrastructure = `the Vite dev server did not come up: ${(error as Error).message}`
      return
    }
    try {
      browser = await chromium.launch()
    } catch (error) {
      infrastructure =
        `Chromium did not launch: ${(error as Error).message.split('\n')[0]} ` +
        `(if this box has never installed browsers, run: npx playwright install chromium)`
      return
    }

    // Past this line the harness is up: a throw is a product defect (the
    // strip or its controls never rendered), not infrastructure.
    for (const scenario of SCENARIOS) {
      const shot = await runScenario('wo1492-live', browser, server.base, scenario, { writeScreenshot: process.env.WRITE_EVIDENCE === '1' })
      shots.push(shot)
    }
  } finally {
    elapsedMs = Date.now() - startedAt
    if (browser) await browser.close()
    if (server) server.stop()
    for (const shot of shots) {
      console.log(
        `[wo1492] ${shot.name} workview=${JSON.stringify(shot.measurement.workview)} ` +
          `strip=${JSON.stringify(shot.measurement.strip)}`,
      )
    }
    console.log(
      `[wo1492] live overlay-strip measurement took ${(elapsedMs / 1000).toFixed(1)}s` +
        (infrastructure ? ` and was INCONCLUSIVE: ${infrastructure}` : ''),
    )
  }
}, BOOT_TIMEOUT_MS)

afterAll(() => {
  if (infrastructure) {
    console.error(`[wo1492] INCONCLUSIVE (infrastructure, not this branch): ${infrastructure}`)
  }
})

describe('WO-1492: the sketch-empty-hint and sketch-confirm-overlay strips are MEASURED in a real browser', () => {
  it('started a dev server and a browser on this worktree, or says so out loud', () => {
    requireLive()
    for (const shot of shots) {
      expect(shot.pageErrors).toEqual([])
      expect(shot.measurement.workview).not.toBeNull()
      expect(shot.measurement.strip).not.toBeNull()
    }
  })

  it('BUG-386: the empty-sketch hint strip stays inside the workview at 1600x1000', () => {
    requireLive()
    const shot = shotFor('empty-hint')
    const workview = shot.measurement.workview!
    const strip = shot.measurement.strip!
    expect(
      isInside(strip, workview),
      `sketch-empty-hint ${JSON.stringify(strip)} is not fully inside the workview ${JSON.stringify(workview)}`,
    ).toBe(true)
  })

  it('BUG-386: the dismiss button stays reachable inside the workview at 1600x1000', () => {
    requireLive()
    const shot = shotFor('empty-hint')
    const workview = shot.measurement.workview!
    const dismiss = shot.measurement.controls.find((c) => c.name === 'dismiss button')
    expect(dismiss?.box, 'dismiss button never rendered').not.toBeNull()
    expect(
      isInside(dismiss!.box!, workview),
      `sketch-empty-hint-dismiss ${JSON.stringify(dismiss!.box)} is not fully inside the workview ${JSON.stringify(workview)}`,
    ).toBe(true)
  })

  it('BUG-388: the Circular Pattern confirm strip stays inside the workview at 1024x768', () => {
    requireLive()
    const shot = shotFor('circular-confirm')
    const workview = shot.measurement.workview!
    const strip = shot.measurement.strip!
    expect(
      isInside(strip, workview),
      `sketch-confirm-overlay ${JSON.stringify(strip)} is not fully inside the workview ${JSON.stringify(workview)}`,
    ).toBe(true)
  })

  it.each(['Count field', 'OK button', 'Cancel button'])(
    'BUG-388: the %s stays reachable inside the workview at 1024x768',
    (name) => {
      requireLive()
      const shot = shotFor('circular-confirm')
      const workview = shot.measurement.workview!
      const control = shot.measurement.controls.find((c) => c.name === name)
      expect(control?.box, `${name} never rendered`).not.toBeNull()
      expect(
        isInside(control!.box!, workview),
        `${name} ${JSON.stringify(control!.box)} is not fully inside the workview ${JSON.stringify(workview)}`,
      ).toBe(true)
    },
  )

  // Acceptance 4: other .sketch-confirm-overlay flows must be visually
  // unchanged at normal widths. Audit (attempt 1) found the 560px clamp
  // re-wrapped this same strip onto extra rows even at 1920x1080/1600x1000,
  // where its ~880px natural width already fits -- this proves the clamp
  // sized to content (app.css:8380) no longer does that.
  it('BUG-388 fix: the Circular Pattern confirm strip does NOT wrap at a normal desktop width (1920x1080)', () => {
    requireLive()
    const shot = shotFor('circular-confirm-normal')
    const boxes = ['Count field', 'OK button', 'Cancel button'].map((name) => {
      const control = shot.measurement.controls.find((c) => c.name === name)
      expect(control?.box, `${name} never rendered`).not.toBeNull()
      return control!.box!
    })
    expect(
      allSameRow(boxes),
      `Count field/OK/Cancel are not on the same row at 1920x1080 (wrapped): ${JSON.stringify(boxes)}`,
    ).toBe(true)
  })
})
