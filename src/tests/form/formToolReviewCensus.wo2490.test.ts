// @vitest-environment jsdom
//
// WO-2490: the Form new-user review covers every Form rail button. The rail is read from the production hook
// (useFormSession railSections, Undo and Redo both showing); each button must have a verdict in the review's
// verdicts.json, at least one walked step with frames on disk in results-<phase>.json (tools/capture/form-review.mjs),
// and - unless it is WORKS-CLEAR - a proposal card on the findings page. A rail button added later without a
// review fails here.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import { useFormSession } from '../../components/model3d/form/useFormSession'
import { useFormStore } from '../../form/formStore'

const DIR = path.resolve(__dirname, '../evidence/WO-2490')
const VERDICTS = ['WORKS-CLEAR', 'WORKS-UNCLEAR', 'BROKEN', 'NEEDS-KNOWLEDGE']

interface Verdict { verdict: string; card: string | null; saw: string; help: string }
interface Step { step: string; frames: string[] }

function railTestIds(): string[] {
  const dag = new FeatureDag()
  const st = useFormStore.getState()
  st.openSession({ featureId: null, name: 'Form 1' })
  // two recorded edits, one undone: Undo and Redo both on the rail
  st.newFromStarter('box')
  st.newFromStarter('sphere')
  st.undo()
  const { result } = renderHook(() => useFormSession({
    runtime: null, canvasRef: { current: null }, dag, history: new CommandHistory(dag), onApplied: vi.fn(), showBody: vi.fn(),
  }))
  return result.current.railSections.flatMap((s) => s.tools.map((t) => t.testId))
}

function walked(): Map<string, Step[]> {
  const steps = new Map<string, Step[]>()
  for (const f of readdirSync(DIR).filter((n) => /^results-[a-z]+\.json$/.test(n))) {
    const run = JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as { tools: Array<{ tool: string; steps: Step[] }> }
    for (const t of run.tools) steps.set(t.tool, [...(steps.get(t.tool) ?? []), ...t.steps])
  }
  return steps
}

describe('WO-2490 Form tool review census', () => {
  afterEach(() => { cleanup(); useFormStore.getState().closeSession() })

  it('the rail as the app builds it has every group and Undo/Redo', () => {
    const ids = railTestIds()
    expect(ids).toContain('form-starter-box')
    expect(ids).toContain('form-undo')
    expect(ids).toContain('form-redo')
    // WO-2504: one reviewed tool is hidden until after the alpha; all offered tools still need coverage.
    expect(ids).not.toContain('form-pull-body')
    expect(ids.length).toBeGreaterThanOrEqual(48)
  })

  it('every rail button has a verdict, walked frames on disk and, unless clear, a findings card', () => {
    const verdicts = JSON.parse(readFileSync(path.join(DIR, 'verdicts.json'), 'utf8')) as { tools: Record<string, Verdict> }
    const steps = walked()
    const html = readFileSync(path.join(DIR, 'findings.html'), 'utf8')
    const missing: string[] = []
    for (const id of railTestIds()) {
      const v = verdicts.tools[id]
      if (v === undefined) { missing.push(`${id}: no verdict`); continue }
      if (!VERDICTS.includes(v.verdict)) missing.push(`${id}: verdict "${v.verdict}"`)
      const walk = steps.get(id) ?? []
      if (walk.length === 0) missing.push(`${id}: never walked`)
      for (const s of walk) for (const f of s.frames) if (!existsSync(path.join(DIR, f))) missing.push(`${id}: frame ${f} not on disk`)
      if (v.verdict !== 'WORKS-CLEAR' && (v.card === null || !html.includes(`data-id="${v.card}"`))) missing.push(`${id}: ${v.verdict} without a card on findings.html`)
      if (!html.includes(`data-tool="${id}"`)) missing.push(`${id}: not in the findings summary table`)
    }
    expect(missing).toEqual([])
  })
})
