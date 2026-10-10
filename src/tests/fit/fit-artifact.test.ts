/**
 * WO-1142: static armor over the committed fit-sweep artifact.
 *
 * Runs the sweep itself? No - that boots a dev server and a browser, which
 * belongs to the CLI harness (fit-sweep.mjs), not to this slice. What the
 * slice CAN assert cheaply is every mechanical property the WO promises
 * about findings.json: it exists, every surface-width combination is
 * represented (MEASURED or SKIPPED-with-reason), defect rows carry the full
 * schema, the canonical sort holds, and the file is exactly its own
 * canonical serialization - which is what makes two runs byte-identical.
 */
import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const findingsUrl = new URL('../evidence/WO-1142/findings.json', import.meta.url)
const findingsPath = findingsUrl.pathname.replace(/^\/([A-Za-z]:)/, '$1')

const SURFACES = [
  'Part', 'Tool Library', 'Post Process', 'Control',
  'Setup', 'Toolpath', 'Simulate', 'Sketch', 'Model',
]
const WIDTHS = ['1440x900', '1680x900']
const DEFECTS = ['overflow', 'escapes-parent', 'text-clipped']
const defectOrder: Record<string, number> = { 'escapes-parent': 0, overflow: 1, 'text-clipped': 2 }

type Row = {
  surface: string
  width: string
  status?: 'MEASURED' | 'SKIPPED'
  reason?: string
  findingsCount?: number
  selector?: string
  className?: string
  defect?: string
  operationSelected?: boolean
}

// WO-1295 acceptance: these five surfaces must be measured with a project
// OPEN and an operation SELECTED.
const PROJECT_SURFACES = ['Setup', 'Toolpath', 'Simulate', 'Sketch', 'Model']

const raw = readFileSync(findingsPath, 'utf8')
const rows = JSON.parse(raw) as Row[]

describe('WO-1142 fit sweep artifact', () => {
  it('findings.json exists and is an array', () => {
    expect(existsSync(findingsPath)).toBe(true)
    expect(Array.isArray(rows)).toBe(true)
  })

  it('covers all 18 surface-width combinations with a MEASURED or SKIPPED row', () => {
    for (const surface of SURFACES) {
      for (const width of WIDTHS) {
        const combo = rows.filter((r) => r.surface === surface && r.width === width && r.status)
        expect(combo.length, `${surface} @ ${width} has no status row`).toBe(1)
        const row = combo[0]
        expect(['MEASURED', 'SKIPPED']).toContain(row.status)
        if (row.status === 'SKIPPED') expect(row.reason!.length).toBeGreaterThan(0)
        if (row.status === 'MEASURED') {
          expect(typeof row.findingsCount).toBe('number')
          const defects = rows.filter((r) => r.surface === surface && r.width === width && !r.status).length
          expect(row.findingsCount).toBe(defects)
        }
      }
    }
  })

  it('measured the five project surfaces with an operation selected (WO-1295)', () => {
    for (const surface of PROJECT_SURFACES) {
      for (const width of WIDTHS) {
        const row = rows.find((r) => r.surface === surface && r.width === width && r.status === 'MEASURED')
        expect(row?.operationSelected, `${surface} @ ${width} must be measured with an operation selected`).toBe(true)
      }
    }
  })

  it('every defect row carries the full schema', () => {
    for (const r of rows.filter((r) => !r.status)) {
      expect(SURFACES).toContain(r.surface)
      expect(WIDTHS).toContain(r.width)
      expect(DEFECTS).toContain(r.defect)
      expect(typeof r.selector).toBe('string')
      expect(r.selector!.length).toBeGreaterThan(0)
      expect(typeof r.className).toBe('string')
    }
  })

  it('is canonically sorted (surface, width, selector, defect)', () => {
    const key = (r: Row) => `${r.surface}\u0000${r.width}\u0000${r.selector ?? ''}\u0000${r.status ? -1 : defectOrder[r.defect!] ?? 3}`
    const keys = rows.map(key)
    const sorted = [...keys].sort()
    expect(keys).toEqual(sorted)
  })

  it('is byte-identical to its own canonical serialization', () => {
    expect(raw).toBe(JSON.stringify(rows, null, 2) + '\n')
  })
})
