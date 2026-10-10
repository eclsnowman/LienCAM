import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface FooterCapture {
  viewport: { width: number; height: number }
  footer: {
    clientWidth: number
    scrollWidth: number
    contentOverflowPx: number
    rightEdgeOverflowPx: number
  }
  buttons: Array<{
    label: string
    rightEdgeOverflowPx: number
    labelLineCount: number
    labelSingleLine: boolean
    textOverflow: string
    labelClipped: boolean
  }>
  controllerActions: {
    uccncExportProPresent: boolean
    grblExportProPresent?: boolean
  }
}

interface FooterEvidence {
  wo: string
  phase: 'before' | 'after'
  edgeTolerancePx: number
  captures: FooterCapture[]
}

const before = JSON.parse(
  readFileSync('src/tests/evidence/WO-1112/measurements.before.json', 'utf8'),
) as FooterEvidence
const after = JSON.parse(
  readFileSync('src/tests/evidence/WO-1112/measurements.json', 'utf8'),
) as FooterEvidence

const viewportTags = (evidence: FooterEvidence) => evidence.captures.map(
  ({ viewport }) => `${viewport.width}x${viewport.height}`,
)

describe('WO-1112 Machine Library footer fit', () => {
  it('records the real pre-change overflow at both required viewports', () => {
    expect(before.phase).toBe('before')
    expect(viewportTags(before)).toEqual(['1440x900', '1680x900'])
    for (const capture of before.captures) {
      expect(capture.footer.scrollWidth).toBeGreaterThan(capture.footer.clientWidth)
      expect(capture.footer.contentOverflowPx).toBeGreaterThan(before.edgeTolerancePx)
      expect(capture.footer.rightEdgeOverflowPx).toBeGreaterThan(before.edgeTolerancePx)
    }
  })

  it('keeps every UCCNC footer action inside the modal on one unellipsized line', () => {
    expect(after.phase).toBe('after')
    expect(viewportTags(after)).toEqual(['1440x900', '1680x900'])
    for (const capture of after.captures) {
      expect(capture.footer.scrollWidth).toBe(capture.footer.clientWidth)
      expect(capture.footer.contentOverflowPx).toBe(0)
      expect(capture.footer.rightEdgeOverflowPx).toBeLessThanOrEqual(after.edgeTolerancePx)
      expect(capture.buttons.map(({ label }) => label)).toEqual([
        'Delete',
        'Export',
        'Export .pro',
        'Save Changes',
        'Set as Default',
        'Use for this project',
      ])
      for (const button of capture.buttons) {
        expect(button.rightEdgeOverflowPx, button.label).toBeLessThanOrEqual(after.edgeTolerancePx)
        expect(button.labelLineCount, button.label).toBe(1)
        expect(button.labelSingleLine, button.label).toBe(true)
        expect(button.textOverflow, button.label).not.toBe('ellipsis')
        expect(button.labelClipped, button.label).toBe(false)
      }
    }
  })

  it('shows Export .pro for UCCNC and omits it for GRBL', () => {
    for (const capture of after.captures) {
      expect(capture.controllerActions.uccncExportProPresent).toBe(true)
      expect(capture.controllerActions.grblExportProPresent).toBe(false)
    }
  })
})
