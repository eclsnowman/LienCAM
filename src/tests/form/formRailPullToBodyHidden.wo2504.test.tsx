// @vitest-environment jsdom
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import { useFormSession } from '../../components/model3d/form/useFormSession'
import { useFormStore } from '../../form/formStore'
import { topics } from '../../help/topics/form'
import { FormPanel } from '../../components/model3d/form/FormPanel'
import { WorkbenchToolRail } from '../../components/model3d/workbench/WorkbenchToolRail'

interface Section { id: string; title: string; tools: string[] }
// Captured through useFormSession on the unchanged source, with both history buttons present.
const before = JSON.parse(readFileSync(path.resolve(__dirname, '../evidence/WO-2504/before.json'), 'utf8')) as { sections: Section[]; topics: unknown[] }

function FormWorkbench() {
  const dag = new FeatureDag()
  const session = useFormSession({
    runtime: null, canvasRef: { current: null }, dag, history: new CommandHistory(dag), onApplied: vi.fn(), showBody: vi.fn(),
  })
  return <>
    <FormPanel session={session} />
    <WorkbenchToolRail sketchActive={false} modelingSections={session.railSections} sketchHistoryTools={[]} onFinishSketch={vi.fn()} />
  </>
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); useFormStore.getState().closeSession() })

it.each(['fresh', 'undo', 'undo-redo', 'redo'])('hides only Pull to body through the production panel and rail (%s)', (history) => {
  window.localStorage.clear()
  const st = useFormStore.getState()
  st.openSession({ featureId: null, name: 'Form 1' })
  if (history !== 'fresh') st.newFromStarter('box')
  if (history === 'undo-redo') st.newFromStarter('sphere')
  if (history === 'undo-redo' || history === 'redo') st.undo()
  render(<FormWorkbench />)
  expect(screen.queryByTestId('form-pull-body')).toBeNull()
  const expected = before.sections.map(s => ({ ...s, tools: s.tools.filter(id =>
    id !== 'form-pull-body' && (id !== 'form-undo' || history === 'undo' || history === 'undo-redo') &&
    (id !== 'form-redo' || history === 'redo' || history === 'undo-redo'),
  ) })).filter(s => s.tools.length > 0)
  const rail = screen.getByTestId('workbench-modeling-toolbar')
  const sections = [...rail.querySelectorAll<HTMLElement>('.tree-section')].map(s => ({
    id: s.dataset.testid!.replace('workbench-rail-section-', ''),
    tools: [...s.querySelectorAll<HTMLElement>('.sketch-tool-grid button')].map(t => t.dataset.testid),
  }))
  expect(sections).toEqual(expected.map(({ id, tools }) => ({ id, tools })))
  for (const s of expected) expect(screen.getByTestId(`workbench-rail-section-${s.id}`).textContent).toContain(s.title)
  const pull = vi.spyOn(useFormStore.getState(), 'pullSelection')
  fireEvent.click(screen.getByTestId('form-pull'))
  expect(pull).toHaveBeenCalledOnce()
})

it('keeps the hidden tool out of Form Help after the WO-2626 wording corrections', () => {
  const hiddenSentence = ' Pull to body pulls the skin at the selected points onto the body selected in the tree.'
  expect(JSON.stringify(before.topics)).toContain(hiddenSentence)
  // WO-2626 corrected starter fields, display fields and Model-tab wording.
  // Retain an exact Help snapshot and both independent Pull assertions.
  const golden = path.resolve(__dirname, '../evidence/WO-2650/form-help.after.json')
  if (process.env.WO2650_RECORD === '1') writeFileSync(golden, JSON.stringify(topics, null, 2) + '\n')
  expect(topics).toEqual(JSON.parse(readFileSync(golden, 'utf8')))
  expect(JSON.stringify(topics)).not.toContain('Pull to body')
  expect(JSON.stringify(topics)).toContain('Pull moves the cage so the smooth skin passes through the selected points where they are now.')
})
