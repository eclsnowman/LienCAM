// @vitest-environment jsdom
//
// WO-2911 worked example 2 (Model): a real Model failure reported from the
// app, then reproduced from the bundle alone.
//
// The operator imports a STEP part in the Model workspace (the real workbench
// page, the real in-process OCCT kernel, the fake scene runtime every
// workbench test uses - jsdom has no WebGL). The part is an open shell, so the
// console says Mass Properties was refused. The operator presses Report this
// problem on that line and ticks Current project.
//
// Then a fresh reader, holding only the ZIP: a clean app, open
// project-current.camproject, open the Model workspace - and must see the
// exact text in the report.
//
// WRITE_EVIDENCE=1 (the repo's evidence-refresh switch) also writes the ZIP to src/tests/evidence/WO-2911/.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { strFromU8, unzipSync } from 'fflate'
import { typedMock } from '../support/typedMock'

const { stepCacheStore } = vi.hoisted(() => ({ stepCacheStore: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stepCache')>()
  return typedMock<typeof import('../../lib/stepCache')>({
    ...actual,
    cacheStep: vi.fn(async (id: string, buf: ArrayBuffer) => { stepCacheStore.set(id, buf) }),
    loadCachedStep: vi.fn(async (id: string) => stepCacheStore.get(id) ?? null),
    removeCachedStep: vi.fn(async (id: string) => { stepCacheStore.delete(id) }),
  })
})

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
  configurable: true,
})

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { createFakeSceneRuntime } = await import('../model3d/fakeSceneRuntime')
const { waitForLoadedModel3d: waitFor } = await import('../model3d/loadTolerantWaitFor')
const { stubCanvas2d } = await import('../model3d/stubCanvas2d')
const { resetDocumentHolder } = await import('../../doc/documentHolder')
const { useCamStore } = await import('../../store')
const diagnostics = await import('../../lib/diagnostics')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const STEP = join(HERE, '../model3d/fixtures/wo1455/open-shell-30x20x10.step')

afterEach(cleanup)

const refusal = () => useCamStore.getState().consoleEvents.filter(
  (e) => e.severity === 'warning' && e.source === 'model' && /is not a closed solid/.test(e.message))

async function mountWorkbench() {
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => createFakeSceneRuntime()} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
}

describe('WO-2911 worked example: Model failure -> bundle -> reproduction', () => {
  it('the bundle alone reproduces the same console text', async () => {
    const restoreCanvas = stubCanvas2d()
    try {
      // --- The operator's session ------------------------------------------
      resetDocumentHolder()
      useCamStore.getState().newProject()
      useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
      await mountWorkbench()
      const bytes = readFileSync(STEP)
      const file = new File([bytes], 'open-shell-30x20x10.step', { type: 'application/octet-stream' })
      fireEvent.change(screen.getByTestId('workbench-import-step-input'), { target: { files: [file] } })
      await waitFor(() => expect(screen.getByTestId('feature-row-IMP1')).toBeTruthy(), { timeout: 20_000 })
      await waitFor(() => expect(refusal()).toHaveLength(1), { timeout: 20_000 })
      const line = refusal()[0]

      const failure = diagnostics.failureFromConsoleEvent(line.id)!
      expect(failure).toMatchObject({ route: 'model', source: 'model', errorText: line.message, operation: null })
      const h = diagnostics.diagnosticHistory()
      await h.whenReady()
      const frozen = diagnostics.freezeReportSources(h.currentSessionId, { project: null, program: null, image: null })
      const currentProject = await diagnostics.readCurrentProject()
      expect(currentProject).not.toBeNull()
      const report = await diagnostics.buildReport(
        { ...diagnostics.DEFAULT_CHOICES, ...diagnostics.FAILURE_CHOICES, appImage: false, operationSettings: false, currentProject: true },
        {
          ...frozen, consoleTail: diagnostics.readConsoleTail(), currentProject,
          reproduction: {
            failure,
            expected: 'Mass, volume and center of mass for the imported part.',
            actual: `The app showed: ${failure.errorText}`,
            steps: diagnostics.suggestedSteps(failure).replace(/^3\. .*$/m, '3. Nothing more: the line appears as soon as the workspace opens, when Mass Properties runs on the imported part open-shell-30x20x10 (feature IMP1, already in the project).'),
          },
        },
      )
      expect(report.problems).toEqual([])
      if (process.env.WRITE_EVIDENCE === '1') writeFileSync(join(ROOT, 'src/tests/evidence/WO-2911/worked-example-model.zip'), report.zip)

      // --- A fresh reader with only the ZIP ----------------------------------
      cleanup()
      const files = unzipSync(report.zip)
      const r = JSON.parse(strFromU8(files['manifest.json'])).reproduction
      expect(r.route).toBe('model')
      expect(r.project).toBe('project-current.camproject')
      resetDocumentHolder()
      stepCacheStore.clear()
      useCamStore.getState().newProject()
      useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
      await act(async () => { await useCamStore.getState().loadProjectFromFile(strFromU8(files[r.project])) })
      await mountWorkbench()
      await waitFor(() => expect(screen.getByTestId('feature-row-IMP1')).toBeTruthy(), { timeout: 20_000 })
      await waitFor(() => expect(useCamStore.getState().consoleEvents.map((e) => e.message)).toContain(r.failure.errorText), { timeout: 20_000 })
    } finally {
      restoreCanvas()
    }
  }, 90_000)
})
