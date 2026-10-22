// WO-2911 worked example 1 (CAM): a real CAM failure reported from the app,
// then reproduced from the bundle alone.
//
// The operator opens the shipped "Adaptive Clearing Shapes" example, gives
// "Adaptive Clearing - Bar" a 60 mm tool and generates it through the
// production entry (computeOperationToolpath, the real toolpathWorker). The
// console says the operation cut nothing because there was nothing left to
// cut (WO-3024: a zero-pass result is an error line, no longer a 'stopped
// early ... 0 pass(es) kept' warning). The operator presses
// Report this problem on that line and ticks Current project.
//
// Then a fresh reader, holding only the ZIP, does what reproduction.md says:
// a clean app, open project-current.camproject, select the named operation in
// the named setup, generate - and must see the exact text in the report.
//
// WRITE_EVIDENCE=1 (the repo's evidence-refresh switch) also writes the ZIP to src/tests/evidence/WO-2911/
// (the bundle the fresh-reader check in CONTEXT.md reads).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { installRealToolpathWorker } from '../helpers/heightScenario'

installRealToolpathWorker()
const { useCamStore } = await import('../../store')
const diagnostics = await import('../../lib/diagnostics')

const ROOT = path.resolve(__dirname, '../../..')
const EXAMPLE = path.join(ROOT, 'Example Projects', 'Adaptive Clearing Shapes.camproject')
const OP_NAME = 'Adaptive Clearing - Bar'

function findOp(setupName: string | null, opName: string) {
  for (const setup of useCamStore.getState().project.setups) {
    if (setupName !== null && setup.name !== setupName) continue
    const op = setup.operations.find((o) => o.name === opName)
    if (op) return { setup, op }
  }
  return null
}

describe('WO-2911 worked example: CAM failure -> bundle -> reproduction', () => {
  it('the bundle alone reproduces the same console text', async () => {
    // --- The operator's session --------------------------------------------
    await useCamStore.getState().loadProjectFromFile(fs.readFileSync(EXAMPLE, 'utf8'))
    const found = findOp(null, OP_NAME)!
    useCamStore.getState().updateTool(found.op.toolId, { diameter: 60 })
    await useCamStore.getState().computeOperationToolpath(found.setup.id, found.op.id)
    const line = useCamStore.getState().consoleEvents.filter((e) =>
      e.severity === 'error' && e.entityRef?.kind === 'op' && e.entityRef.id === found.op.id).at(-1)!
    expect(line?.message).toContain('cut nothing because there was nothing left to cut')

    const failure = diagnostics.failureFromConsoleEvent(line.id)!
    expect(failure).toMatchObject({ route: 'cam', source: 'compute', errorText: line.message })
    expect(failure.operation).toMatchObject({ name: OP_NAME, family: 'adaptive_clearing_2d', setupName: found.setup.name })
    expect(failure.operation!.settings!.tool!.diameter).toBe(60)

    const h = diagnostics.diagnosticHistory()
    await h.whenReady()
    const frozen = diagnostics.freezeReportSources(h.currentSessionId, { project: null, program: null, image: null })
    const currentProject = await diagnostics.readCurrentProject()
    expect(currentProject).not.toBeNull()
    const report = await diagnostics.buildReport(
      { ...diagnostics.DEFAULT_CHOICES, ...diagnostics.FAILURE_CHOICES, currentProject: true },
      {
        // The picture: the real app at this failure (raw/after-1-console.png, Playwright, 1680x979).
        ...frozen, image: { kind: 'png', bytes: new Uint8Array(fs.readFileSync(path.join(ROOT, 'src/tests/evidence/WO-2911/raw/after-1-console.png'))) }, operationSettings: failure.operation!.settings, consoleTail: diagnostics.readConsoleTail(), currentProject,
        reproduction: {
          failure,
          expected: 'A roughing toolpath for the Bar pocket.',
          actual: `The app showed: ${failure.errorText}`,
          steps: diagnostics.suggestedSteps(failure).replace('3. Generate its toolpath.', '3. Generate its toolpath (its tool is already 60 mm in this project file).'),
        },
      },
    )
    expect(report.problems).toEqual([])
    if (process.env.WRITE_EVIDENCE === '1') {
      fs.writeFileSync(path.join(ROOT, 'src/tests/evidence/WO-2911/worked-example-cam.zip'), report.zip)
    }

    // --- A fresh reader with only the ZIP ------------------------------------
    const files = unzipSync(report.zip)
    const manifest = JSON.parse(strFromU8(files['manifest.json']))
    const r = manifest.reproduction
    expect(r.project).toBe('project-current.camproject')
    expect(strFromU8(files['reproduction.md'])).toContain(`select the operation "${OP_NAME}"`)

    useCamStore.getState().newProject()
    useCamStore.setState({ toolLibrary: [], consoleEvents: [], consoleReadThroughId: 0 })
    await useCamStore.getState().loadProjectFromFile(strFromU8(files[r.project]))
    const again = findOp(r.failure.operation.setupName, r.failure.operation.name)!
    expect(again).not.toBeNull()
    await useCamStore.getState().computeOperationToolpath(again.setup.id, again.op.id)
    const shown = useCamStore.getState().consoleEvents.map((e) => e.message)
    expect(shown).toContain(r.failure.errorText)
  }, 120_000)
})
