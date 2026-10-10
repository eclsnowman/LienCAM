// @vitest-environment jsdom

import { createHash } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Tool, ToolType } from '../../types'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { useCamStore } = await import('../../store')

type ShapeFixture = Pick<Tool,
  'type' | 'diameter' | 'shankDiameter' | 'overallLength' | 'fluteLength'
  | 'shoulderLength' | 'lengthBelowHolder' | 'cornerRadius' | 'neckDiameter'
  | 'threadFormAngleDeg' | 'threadTeethCount' | 'threadPitch'
  | 'neckTransitionAngleDeg' | 'angleFromAxisDeg'
>

const realistic: Record<ToolType, Omit<ShapeFixture, 'type'>> = {
  flat_end_mill: { diameter: 6, shankDiameter: 6, overallLength: 50, fluteLength: 18, shoulderLength: 22, lengthBelowHolder: 28 },
  ball_end_mill: { diameter: 6, shankDiameter: 6, overallLength: 60, fluteLength: 20, shoulderLength: 25, lengthBelowHolder: 32 },
  bull_nose: { diameter: 12, shankDiameter: 12, overallLength: 75, fluteLength: 25, shoulderLength: 32, lengthBelowHolder: 40, cornerRadius: 1 },
  v_bit: { diameter: 12, shankDiameter: 6, overallLength: 50, fluteLength: 10, shoulderLength: 16, lengthBelowHolder: 25, angleFromAxisDeg: 30 },
  drill: { diameter: 6, shankDiameter: 6, overallLength: 90, fluteLength: 55, shoulderLength: 60, lengthBelowHolder: 65, angleFromAxisDeg: 59 },
  spot_drill: { diameter: 10, shankDiameter: 10, overallLength: 50, fluteLength: 15, shoulderLength: 20, lengthBelowHolder: 28, angleFromAxisDeg: 45 },
  thread_mill: { diameter: 8, shankDiameter: 8, overallLength: 60, fluteLength: 12, shoulderLength: 28, lengthBelowHolder: 35, neckDiameter: 5, threadFormAngleDeg: 60, threadTeethCount: 5, threadPitch: 1.25, neckTransitionAngleDeg: 30 },
  face_mill: { diameter: 32, shankDiameter: 16, overallLength: 70, fluteLength: 8, shoulderLength: 18, lengthBelowHolder: 35 },
  tap: { diameter: 8, shankDiameter: 6.3, overallLength: 70, fluteLength: 25, shoulderLength: 32, lengthBelowHolder: 42 },
  boring_bar: { diameter: 10, shankDiameter: 10, overallLength: 100, fluteLength: 15, shoulderLength: 40, lengthBelowHolder: 60 },
  chamfer_mill: { diameter: 12, shankDiameter: 6, overallLength: 55, fluteLength: 8, shoulderLength: 15, lengthBelowHolder: 25, angleFromAxisDeg: 45 },
  tapered_endmill: { diameter: 6, shankDiameter: 6, overallLength: 60, fluteLength: 25, shoulderLength: 30, lengthBelowHolder: 35, angleFromAxisDeg: 3 },
  countersink: { diameter: 20, shankDiameter: 10, overallLength: 60, fluteLength: 10, shoulderLength: 20, lengthBelowHolder: 30, angleFromAxisDeg: 45 },
  center_drill: { diameter: 6, shankDiameter: 6, overallLength: 45, fluteLength: 8, shoulderLength: 15, lengthBelowHolder: 22, angleFromAxisDeg: 30 },
  reamer: { diameter: 8, shankDiameter: 8, overallLength: 100, fluteLength: 45, shoulderLength: 55, lengthBelowHolder: 65 },
  dovetail_mill: { diameter: 16, shankDiameter: 8, overallLength: 60, fluteLength: 8, shoulderLength: 22, lengthBelowHolder: 30, neckDiameter: 6 },
  slitting_saw: { diameter: 50, shankDiameter: 12, overallLength: 55, fluteLength: 3, shoulderLength: 18, lengthBelowHolder: 28, neckDiameter: 8 },
  lollipop_mill: { diameter: 12, shankDiameter: 6, overallLength: 70, fluteLength: 12, shoulderLength: 30, lengthBelowHolder: 38, neckDiameter: 4 },
  probe: { diameter: 2, shankDiameter: 6, overallLength: 50, fluteLength: 20, shoulderLength: 0, lengthBelowHolder: 35, neckDiameter: 1.2 },
}

const extreme: Record<ToolType, Omit<ShapeFixture, 'type'>> = {
  flat_end_mill: { diameter: 25, shankDiameter: 16, overallLength: 150, fluteLength: 75, shoulderLength: 85, lengthBelowHolder: 100 },
  ball_end_mill: { diameter: 1, shankDiameter: 3, overallLength: 100, fluteLength: 35, shoulderLength: 45, lengthBelowHolder: 70 },
  bull_nose: { diameter: 32, shankDiameter: 20, overallLength: 150, fluteLength: 60, shoulderLength: 75, lengthBelowHolder: 100, cornerRadius: 6 },
  v_bit: { diameter: 32, shankDiameter: 8, overallLength: 80, fluteLength: 18, shoulderLength: 28, lengthBelowHolder: 45, angleFromAxisDeg: 15 },
  drill: { diameter: 3, shankDiameter: 3, overallLength: 100, fluteLength: 70, shoulderLength: 78, lengthBelowHolder: 85, angleFromAxisDeg: 59 },
  spot_drill: { diameter: 3, shankDiameter: 3, overallLength: 80, fluteLength: 20, shoulderLength: 28, lengthBelowHolder: 55, angleFromAxisDeg: 60 },
  thread_mill: { diameter: 3, shankDiameter: 6, overallLength: 100, fluteLength: 18, shoulderLength: 55, lengthBelowHolder: 70, neckDiameter: 1.5, threadFormAngleDeg: 55, threadTeethCount: 12, threadPitch: 0.5, neckTransitionAngleDeg: 15 },
  face_mill: { diameter: 50, shankDiameter: 16, overallLength: 80, fluteLength: 8, shoulderLength: 20, lengthBelowHolder: 40 },
  tap: { diameter: 3, shankDiameter: 4, overallLength: 100, fluteLength: 55, shoulderLength: 65, lengthBelowHolder: 80 },
  boring_bar: { diameter: 3, shankDiameter: 6, overallLength: 150, fluteLength: 12, shoulderLength: 70, lengthBelowHolder: 110 },
  chamfer_mill: { diameter: 32, shankDiameter: 8, overallLength: 90, fluteLength: 15, shoulderLength: 25, lengthBelowHolder: 50, angleFromAxisDeg: 30 },
  tapered_endmill: { diameter: 3, shankDiameter: 6, overallLength: 150, fluteLength: 75, shoulderLength: 90, lengthBelowHolder: 110, angleFromAxisDeg: 1 },
  countersink: { diameter: 50, shankDiameter: 12, overallLength: 80, fluteLength: 12, shoulderLength: 22, lengthBelowHolder: 45, angleFromAxisDeg: 45 },
  center_drill: { diameter: 2, shankDiameter: 6, overallLength: 80, fluteLength: 12, shoulderLength: 25, lengthBelowHolder: 50, angleFromAxisDeg: 30 },
  reamer: { diameter: 3, shankDiameter: 3, overallLength: 150, fluteLength: 80, shoulderLength: 90, lengthBelowHolder: 110 },
  dovetail_mill: { diameter: 32, shankDiameter: 8, overallLength: 90, fluteLength: 10, shoulderLength: 45, lengthBelowHolder: 55, neckDiameter: 4 },
  slitting_saw: { diameter: 80, shankDiameter: 12, overallLength: 60, fluteLength: 2, shoulderLength: 20, lengthBelowHolder: 35, neckDiameter: 6 },
  lollipop_mill: { diameter: 25, shankDiameter: 6, overallLength: 100, fluteLength: 25, shoulderLength: 55, lengthBelowHolder: 65, neckDiameter: 3 },
  probe: { diameter: 6, shankDiameter: 6, overallLength: 120, fluteLength: 60, shoulderLength: 0, lengthBelowHolder: 90, neckDiameter: 4 },
}

const toolTypes = Object.keys(realistic) as ToolType[]

function libraryBytes(): string {
  const { toolLibraries, toolLibrary } = useCamStore.getState()
  return JSON.stringify({ toolLibraries, toolLibrary })
}

function libraryHash(): string {
  return createHash('sha256').update(libraryBytes()).digest('hex')
}

function row(label: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>('.tool-form-section .mform-row'))
    .find((candidate) => candidate.querySelector('.mform-label')?.textContent?.trim().startsWith(label))
  if (!match) throw new Error(`Missing Tool Library row: ${label}`)
  return match
}

function setNumeric(label: string, value: number): void {
  const input = row(label).querySelector('input') as HTMLInputElement | null
  if (!input) throw new Error(`Missing input for Tool Library row: ${label}`)
  act(() => {
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: String(value) } })
    fireEvent.blur(input)
  })
}

function selectTab(name: string): void {
  act(() => { fireEvent.click(screen.getByRole('button', { name })) })
}

function applyFixture(fixture: ShapeFixture): void {
  selectTab('General')
  const typeSelect = row('Type').querySelector('select') as HTMLSelectElement
  act(() => { fireEvent.change(typeSelect, { target: { value: fixture.type } }) })
  selectTab('Cutter')

  // WO-2154: a probe's diameter is its ball and its flute is its stylus.
  const isProbe = fixture.type === 'probe'
  setNumeric(isProbe ? 'Ball (tip) diameter' : 'Diameter', fixture.diameter)
  setNumeric('Shank diameter', fixture.shankDiameter)
  setNumeric('Overall length', fixture.overallLength)
  setNumeric(isProbe ? 'Stylus length (from tip)' : 'Flute length (from tip)', fixture.fluteLength)
  setNumeric('Shoulder length (from tip)', fixture.shoulderLength ?? 0)
  setNumeric('Length below holder', fixture.lengthBelowHolder ?? fixture.fluteLength)

  if (fixture.cornerRadius !== undefined) setNumeric('Corner radius', fixture.cornerRadius)
  if (fixture.neckDiameter !== undefined) setNumeric(isProbe ? 'Stem diameter' : 'Neck diameter', fixture.neckDiameter)
  if (fixture.threadTeethCount !== undefined) setNumeric('Thread teeth (vertical)', fixture.threadTeethCount)
  if (fixture.threadFormAngleDeg !== undefined) setNumeric('Thread form angle (\u00b0 included)', fixture.threadFormAngleDeg)
  if (fixture.threadPitch !== undefined) setNumeric('Thread pitch (blank = plain cylinder)', fixture.threadPitch)
  if (fixture.neckTransitionAngleDeg !== undefined) setNumeric('Neck transition angle (\u00b0 from axis)', fixture.neckTransitionAngleDeg)
  if (fixture.angleFromAxisDeg !== undefined) {
    const angleLabel = fixture.type === 'tapered_endmill'
      ? 'Taper angle (per side, \u00b0)'
      : 'Included tip angle (\u00b0)'
    const displayed = fixture.type === 'tapered_endmill'
      ? fixture.angleFromAxisDeg
      : fixture.angleFromAxisDeg * 2
    setNumeric(angleLabel, displayed)
  }
}

afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-1169 Tool Library diagram shape research', () => {
  it('drives realistic and extreme fixtures for every ToolType without saving them', () => {
    expect(toolTypes).toHaveLength(19)
    expect(new Set(toolTypes)).toEqual(new Set<ToolType>([
      'flat_end_mill', 'ball_end_mill', 'bull_nose', 'v_bit', 'drill', 'spot_drill',
      'thread_mill', 'face_mill', 'tap', 'boring_bar', 'chamfer_mill',
      'tapered_endmill', 'countersink', 'center_drill', 'reamer', 'dovetail_mill',
      'slitting_saw', 'lollipop_mill', 'probe',
    ]))

    render(<ToolLibraryModal />)
    act(() => { useCamStore.getState().openModal('tool-library') })
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'New' })) })
    const beforeBytes = libraryBytes()
    const beforeHash = libraryHash()

    for (const type of toolTypes) {
      for (const dimensions of [realistic[type], extreme[type]]) {
        applyFixture({ type, ...dimensions })
        const svg = document.querySelector('.tool-diagram-col > svg')
        expect(svg, `${type} should render an SVG`).not.toBeNull()
        expect(svg?.getAttribute('viewBox'), `${type} should have a finite diagram viewBox`)
          .toMatch(/^0 0 \d+(?:\.\d+)? \d+(?:\.\d+)?$/)
        const drawingLeft = Number(svg?.getAttribute('data-drawing-left'))
        const drawingRight = Number(svg?.getAttribute('data-drawing-right'))
        const drawingTop = Number(svg?.getAttribute('data-drawing-top'))
        const drawingBottom = Number(svg?.getAttribute('data-drawing-bottom'))
        const drawingWidth = drawingRight - drawingLeft
        const drawingHeight = drawingBottom - drawingTop
        // WO-1173 preserves WO-1170's two profile scales while allowing the
        // outer viewBox to grow around feature-attached drafting dimensions.
        expect(
          drawingWidth > 200 || drawingHeight > 250,
          `${type} should reserve either a wide canvas or a tall drawing area`,
        ).toBe(true)
        expect(svg?.querySelectorAll('.tool-diagram-silhouette').length, `${type} should mark its silhouette paths for layout measurement`).toBeGreaterThan(0)
        expect(svg?.querySelector('rect'), `${type} should render its diagram panel`).not.toBeNull()
        expect(svg?.querySelector('path[d]'), `${type} should render a cutter silhouette`).not.toBeNull()
        expect(svg?.textContent).toContain(type.replace(/_/g, ' '))
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('.tool-form-col .tool-form-section input'))
        expect(inputs.length, `${type} should expose its cutter fields`).toBeGreaterThanOrEqual(7)
        // A blank optional field (WO-2154's uncalibrated probe radii) reads
        // through its placeholder.
        expect(inputs.every((input) => input.value.trim().length > 0 || input.placeholder.trim().length > 0), `${type} fields should remain readable`).toBe(true)
      }
    }

    expect(libraryBytes()).toBe(beforeBytes)
    expect(libraryHash()).toBe(beforeHash)
    expect(screen.getByRole('button', { name: 'Save Changes' })).not.toBeNull()
  })
})
