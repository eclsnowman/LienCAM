/**
 * WO-1116: a production-entry-point fit gate.
 *
 * The WO-1142 artifact is the accepted debt baseline. A current browser
 * sweep may retain those rows, but it must not introduce a new surface,
 * width, selector, defect, or overflow axis combination.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

type Finding = {
  surface: string
  width: string
  status?: 'MEASURED' | 'SKIPPED'
  selector?: string
  defect?: string
  axis?: string
  scroll?: number
  client?: number
  reachable?: boolean
  ellipsis?: boolean
  operationSelected?: boolean
}

// WO-1295 acceptance: these five surfaces must be measured with a project
// OPEN and an operation SELECTED - an empty project (or one with nothing
// selected) proves nothing (see the WO's own "What to build" section 1).
const PROJECT_SURFACES = ['Setup', 'Toolpath', 'Simulate', 'Sketch', 'Model']

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const sweepPath = path.join(here, 'fit-sweep.mjs')
const baselinePath = path.resolve(here, '../evidence/WO-1142/findings.json')
// WO-2621: an explicit output keeps current browser findings/captures for triage.
const outputDir = process.env.FIT_SWEEP_OUT
  ? path.resolve(process.env.FIT_SWEEP_OUT)
  : mkdtempSync(path.join(tmpdir(), 'liencam-fit-sweep-'))
const SURFACES = [
  'Part', 'Tool Library', 'Post Process', 'Control',
  'Setup', 'Toolpath', 'Simulate', 'Sketch', 'Model',
]
const WIDTHS = ['1440x900', '1680x900']
const execFileAsync = promisify(execFile)

afterAll(() => { if (!process.env.FIT_SWEEP_OUT) rmSync(outputDir, { recursive: true, force: true }) })

const signature = (row: Finding) => [
  row.surface,
  row.width,
  row.selector,
  row.defect,
  row.axis ?? '',
].join('|')

const isActionable = (row: Finding) => {
  // Two-pixel vertical scroll deltas come from line-box rounding on labels
  // whose paint box is not clipped. They varied between the baseline browser
  // and this Chromium build, so treating them as layout defects makes the
  // gate non-deterministic rather than protective.
  if (row.defect === 'overflow' && row.axis === 'y' && (row.scroll ?? 0) - (row.client ?? 0) <= 2) return false
  // An element that asks for an ellipsis is declaring that it clips, so its
  // horizontal overflow is the text-clipped row restated, not a second defect.
  // ONE rule judges both, and it is the same rule: is the whole sentence still
  // reachable? A pixel threshold could not have decided this - the identical
  // string overflows by 2px on Windows and by more on the Linux peer.
  if (row.defect === 'overflow' && row.axis === 'x' && row.ellipsis && row.reachable) return false

  // A one-line compact status that still carries its WHOLE sentence in
  // title/aria-label/aria-describedby is a reviewed layout choice, not a defect:
  // nothing is lost, it just stops shouting (ControlTransportBar.tsx). This used
  // to be written as one hardcoded id, so the sibling status line with the
  // identical design and the identical title tripped the gate the moment it
  // appeared. Judge the PROPERTY the exemption was always about - can a reader
  // still get the full text - not the name of the one element that had it.
  if (row.defect === 'text-clipped' && row.reachable) return false

  return row.selector !== '#control-next-action'
}

const isResolvedByThisWorkOrder = (row: Finding) => (
  row.surface === 'Part' && row.defect === 'overflow' && row.axis === 'x'
)

// WO-2645: a ResizableSplit (workbench-split) now wraps the Model page's left
// panel, so every WO-1142 row recorded under that aside sits one wrapper
// deeper. Same elements, same boxes to within 1px (Inspect's lower controls
// below the 900px fold of a panel that SCROLLS) - the accepted debt is carried
// across the rename, never added to: no row is accepted that the baseline did
// not already hold, and the aside's own new escape is fixed, not accepted.
const WORKBENCH_LEFT_PANEL_BEFORE = '#root>div>div:nth-of-type(2)>div>div:nth-of-type(1)>aside:nth-of-type(1)>'
const WORKBENCH_LEFT_PANEL_NOW = '#root>div>div:nth-of-type(2)>div>div:nth-of-type(1)>div>div:nth-of-type(1)>aside>'
const rekeyWorkbenchSplit = (row: Finding): Finding => (
  (row.surface === 'Part' || row.surface === 'Model') && row.selector?.startsWith(WORKBENCH_LEFT_PANEL_BEFORE)
    ? { ...row, selector: WORKBENCH_LEFT_PANEL_NOW + row.selector.slice(WORKBENCH_LEFT_PANEL_BEFORE.length) }
    : row
)

describe('WO-1116 fit sweep gate', () => {
  it('measures every surface at both widths and has no finding signatures beyond the committed WO-1142 baseline', async () => {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Finding[]
    const accepted = new Set(baseline
      .filter((row) => !row.status && isActionable(row) && !isResolvedByThisWorkOrder(row))
      .map(rekeyWorkbenchSplit)
      .map(signature))

    await execFileAsync(process.execPath, [sweepPath], {
      cwd: repoRoot,
      env: { ...process.env, FIT_SWEEP_OUT: outputDir },
      timeout: 480_000,
    })

    const current = JSON.parse(readFileSync(path.join(outputDir, 'findings.json'), 'utf8')) as Finding[]
    for (const surface of SURFACES) {
      for (const width of WIDTHS) {
        const statusRows = current.filter((row) => row.surface === surface && row.width === width && row.status)
        expect(statusRows, `${surface} @ ${width} must have one status row`).toHaveLength(1)
        expect(statusRows[0].status, `${surface} @ ${width} must be measured, not skipped`).toBe('MEASURED')
        if (PROJECT_SURFACES.includes(surface)) {
          expect(statusRows[0].operationSelected, `${surface} @ ${width} must be measured with an operation selected`).toBe(true)
        }
      }
    }
    const introduced = current
      .filter((row) => !row.status && isActionable(row))
      .map(signature)
      .filter((row, index, all) => !accepted.has(row) && all.indexOf(row) === index)

    expect(introduced, `new fit finding(s):\n${introduced.join('\n')}`).toEqual([])
  }, 500_000)
})
