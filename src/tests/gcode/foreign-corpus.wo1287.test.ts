import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildPreviewModel } from '../../lib/machine/previewGeometry'
import { SimulatedController } from '../../lib/machine/simulatedController'
import { lintGcode } from '../../lib/gcode/lint'
import { parseGcode } from '../../lib/gcode/parse'

const FIXTURE_DIR = join(__dirname, '../fixtures/foreign-gcode')

const CASES = {
  'fusion-liencnc-v2-sample.nc': {
    source: 'Fusion 360 output posted by Operator for LienCNC V2',
    load: 'refused',
    cycleStart: false,
    // WO-1644: G43 H draws as the zero shift every route reads it as, so the
    // preview draws the whole file.
    previewRefusal: null,
  },
  'fusion360-issue395-xy.nc': {
    source: 'Fusion 360, user-posted output from GRBL issue 395; not Operator',
    load: 'refused',
    cycleStart: false,
    previewRefusal: 'G28',
    previewRefusalLine: 7,
  },
  'fusion360-drilling-excerpt.nc': {
    source: 'Fusion 360, user-posted drilling excerpt; not Operator',
    load: 'refused',
    cycleStart: false,
    previewRefusal: 'G28',
    previewRefusalLine: 3,
  },
  'linuxcnc-spiral.ngc': {
    source: 'LinuxCNC repository nc_files/spiral.ngc; not Operator',
    load: 'refused',
    cycleStart: false,
    previewRefusal: 'O100',
  },
  'liencam-own-post-baseline.nc': {
    source: 'LienCAM own post, copied from committed WO-023 output; not foreign',
    load: 'ok',
    cycleStart: false,
    previewRefusal: null,
  },
} as const

const HOME_CONVENTION = {
  x: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  y: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  z: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
}

async function connected(): Promise<SimulatedController> {
  const controller = new SimulatedController({}, {
    travelMm: { x: 300, y: 300, z: 100 },
    homeConvention: HOME_CONVENTION,
  })
  await controller.connect({ kind: 'none' })
  return controller
}

describe('WO-1287 foreign G-code corpus', () => {
  it('keeps the fixture manifest in lockstep with every corpus file', () => {
    const files = readdirSync(FIXTURE_DIR).filter((file) => /\.(nc|ngc|gcode)$/i.test(file)).sort()
    expect(files).toEqual(Object.keys(CASES).sort())
  })

  it.each(Object.entries(CASES))('records current text-route behavior for %s', async (filename, expected) => {
    vi.useFakeTimers()
    try {
      const text = readFileSync(join(FIXTURE_DIR, filename), 'utf8')
      const parsed = parseGcode(text)
      const preview = buildPreviewModel(text)
      const findings = lintGcode(text)
      const controller = await connected()
      const load = controller.loadJob(text)

      expect(expected.source.length).toBeGreaterThan(0)
      expect(parsed.lines.length).toBeGreaterThan(0)
      expect(preview.moves.length).toBeGreaterThanOrEqual(0)
      expect(findings).toEqual(expect.any(Array))
      expect(load.ok ? 'ok' : 'refused').toBe(expected.load)
      expect(controller.startJob(), JSON.stringify({ status: controller.status(), progress: controller.jobProgress() })).toBe(expected.cycleStart)
      if (expected.previewRefusal === null) {
        expect(preview.refusal).toBeNull()
        expect(preview.minX).toBeLessThanOrEqual(preview.maxX)
      } else {
        expect(preview.refusal).toMatch(new RegExp(`Line \\d+: ${expected.previewRefusal}\\b`))
        if ('previewRefusalLine' in expected) {
          expect(preview.refusal).toMatch(new RegExp(`^Line ${expected.previewRefusalLine}: ${expected.previewRefusal}\\b`))
        }
        expect(preview.moves).toEqual([])
        expect(preview.polylines).toEqual([])
        expect(preview.workBounds).toBeNull()
      }

      if (!load.ok) expect(load.reason).toMatch(/Line \d+: (?:G18|G43|G53|G81|M2)/)
      if (load.ok) {
        await vi.advanceTimersByTimeAsync(5000)
        expect(controller.jobProgress().phase).toBe(expected.cycleStart ? 'complete' : 'ready')
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
