// @vitest-environment jsdom
// WO-2633: exercise the rendered picker and the existing real IGES reader.
import { createElement } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

// Only substitute the browser worker transport; the importer and OCCT reader
// remain real. Node cannot launch the application's browser Web Worker.
vi.mock('../../geom', async () => {
  const actual = await vi.importActual<typeof import('../../geom')>('../../geom')
  return typedMock<typeof import('../../geom')>({ ...actual, createGeomService: actual.createLocalGeomService })
})

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { importGeometryFile } = await import('../../lib/import/importGeometryFile')
const { topics } = await import('../../help/topics/import-geometry')
const source = readFileSync('src/tests/evidence/WO-1824/fixtures/box-with-hole.solid.igs')

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
})
afterEach(cleanup)

function picker(): HTMLInputElement {
  render(createElement(DesignTree))
  return screen.getByTestId('geo-file-input') as HTMLInputElement
}

describe('WO-2633 import picker offers the IGES formats it reads', () => {
  for (const ext of ['igs', 'iges', 'IGS', 'IGES']) {
    it(`offers and reads .${ext} through the production import path`, async () => {
      const accepted = picker().accept.toLowerCase().split(',')
      expect(accepted).toContain(`.${ext.toLowerCase()}`)

      const importBrepGeometry = vi.fn(async (_file: File) => {})
      const addGeometry = vi.fn()
      await act(async () => {
        await importGeometryFile(new File([source], `part.${ext}`), { importBrepGeometry, addGeometry })
      })
      expect(importBrepGeometry).toHaveBeenCalledTimes(1)
      const handed = importBrepGeometry.mock.calls[0][0]
      expect(handed.name).toBe(`part.${ext}`)
      expect(new TextDecoder().decode(await handed.arrayBuffer())).toMatch(/^ISO-10303-21/)
      expect(addGeometry).not.toHaveBeenCalled()
      expect(useCamStore.getState().consoleEvents.some(event =>
        event.source === 'import' && event.message.includes('IGES -- 1 solid'),
      )).toBe(true)
    })
  }

  it('keeps all previously offered geometry and workholding formats', () => {
    expect(picker().accept.toLowerCase().split(',')).toEqual(expect.arrayContaining([
      '.stl', '.obj', '.dxf', '.svg', '.step', '.stp', '.json',
    ]))
  })

  it('Help says both IGES extensions are listed without an All files workaround', () => {
    const topic = topics.find(item => item.id === 'import-step')!
    const paragraph = topic.sections.find(section =>
      section.kind === 'paragraph' && section.text.includes('An IGES file'),
    )
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('Missing IGES help paragraph')
    expect(paragraph.text).toContain('.igs or .iges')
    expect(paragraph.text).toContain('file dialog lists both extensions')
    expect(paragraph.text).not.toMatch(/All files/i)
    expect(paragraph.text).toContain('a file with only surfaces still imports and says so')
  })
})
