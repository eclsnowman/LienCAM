// @vitest-environment jsdom
//
// UI-32 structural render smoke. jsdom does not perform sticky layout, so
// this gate proves the real rail renders the Finish action as the first child
// of its scroll body, applies the production class, and that the class's actual
// app.css rule declares position: sticky. The real-browser capture owns the
// computed-style and pixel/scroll behavior assertions.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Undo2 } from 'lucide-react'
import { readFileSync } from 'node:fs'

import {
  WorkbenchToolRail,
  type RailSection,
  type RailTool,
} from '../../components/model3d/workbench/WorkbenchToolRail'

const noop = () => {}
const appCss = readFileSync('src/styles/app.css', 'utf8')

const longHistory: RailTool[] = Array.from({ length: 18 }, (_, index) => ({
  testId: `ui32-history-${index}`,
  label: `Step ${index + 1}`,
  icon: Undo2,
  onClick: noop,
}))

const longModelingSections: RailSection[] = Array.from({ length: 8 }, (_, sectionIndex) => ({
  id: `ui32-model-${sectionIndex}`,
  title: `Model ${sectionIndex + 1}`,
  tools: Array.from({ length: 6 }, (_, toolIndex) => ({
    testId: `ui32-model-${sectionIndex}-${toolIndex}`,
    label: `Tool ${toolIndex + 1}`,
    icon: Undo2,
    onClick: noop,
  })),
}))

afterEach(() => cleanup())

describe('UI-32: Finish sketch remains the pinned first action in a long sketch rail', () => {
  it('renders the Finish toolbar first in panel-body with the sticky production class', () => {
    render(
      <WorkbenchToolRail
        sketchActive
        modelingSections={longModelingSections}
        sketchHistoryTools={longHistory}
        onFinishSketch={noop}
      />,
    )

    const finish = screen.getByTestId('workbench-finish-package-sketch')
    const toolbar = screen.getByTestId('workbench-package-sketch-toolbar')
    const rail = screen.getByTestId('workbench-right-rail')
    const panelBody = rail.querySelector(':scope > .panel-body')

    expect(finish).toBeTruthy()
    expect(panelBody).not.toBeNull()
    expect(panelBody?.firstElementChild).toBe(toolbar)
    expect(toolbar.classList.contains('sketch-finish-sticky')).toBe(true)
    expect(appCss).toMatch(/\.sketch-finish-sticky\s*\{[^}]*position:\s*sticky;/s)
    expect(screen.getByTestId('ui32-history-17')).toBeTruthy()
  })

  it('does not render the sticky sketch toolbar in modeling mode', () => {
    render(
      <WorkbenchToolRail
        sketchActive={false}
        modelingSections={longModelingSections}
        sketchHistoryTools={longHistory}
        onFinishSketch={noop}
      />,
    )

    expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull()
    expect(screen.getByTestId('workbench-modeling-toolbar')).toBeTruthy()
    expect(screen.getByTestId('workbench-right-rail').getAttribute('data-rail-mode')).toBe('modeling')
  })
})
