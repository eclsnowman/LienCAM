// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const harness = vi.hoisted(() => ({
  instances: [] as Array<{
    setCameraView: ReturnType<typeof vi.fn>
    fitBoundsPreservingView: ReturnType<typeof vi.fn>
    fitToolpathPreservingView: ReturnType<typeof vi.fn>
  }>,
}))

// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
  CNCViewport: class {
    setCameraView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    fitToolpathPreservingView = vi.fn()
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
    constructor() { harness.instances.push(this) }
  },
}))

Object.defineProperty(globalThis, 'requestAnimationFrame', {
  value: vi.fn(() => 1),
  configurable: true,
})
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true })

const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const { useMachineControl } = await import('../../store/machineControlStore')

function setPreviewState(programText = 'G0 X0 Y0 Z5\nG1 X20 Y10 Z-2 F100') {
  useMachineControl.setState({
    programText,
    connectionPhase: 'connected',
    connectionKind: 'serial',
    activeWcs: 'G54',
    offsets: { G54: [0, 0, 0] },
    settings: { 130: '300.000', 131: '200.000', 132: '100.000' },
    homed: true,
  })
}

beforeEach(() => {
  cleanup()
  harness.instances.length = 0
  setPreviewState()
})

afterEach(cleanup)

describe('WO-383 Control viewport view rail', () => {
  it('routes all four named orientation buttons to the established camera poses', () => {
    render(<ProgramPreview />)
    const viewport = harness.instances[0]

    fireEvent.click(screen.getByRole('button', { name: 'Top view' }))
    fireEvent.click(screen.getByRole('button', { name: 'Front view' }))
    fireEvent.click(screen.getByRole('button', { name: 'Right view' }))
    fireEvent.click(screen.getByRole('button', { name: 'Isometric view' }))

    expect(viewport.setCameraView.mock.calls).toEqual([
      ['top'],
      ['front'],
      ['right'],
      ['iso'],
    ])
  })

  it('fits the signed machine envelope and loaded program through separate actions', () => {
    render(<ProgramPreview />)
    const viewport = harness.instances[0]

    fireEvent.click(screen.getByRole('button', { name: 'Fit machine extents' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fit program extents' }))

    const bounds = viewport.fitBoundsPreservingView.mock.calls[0][0]
    expect(bounds.max.x - bounds.min.x).toBe(300)
    expect(bounds.max.y - bounds.min.y).toBe(200)
    expect(bounds.max.z - bounds.min.z).toBe(100)
    expect(viewport.fitToolpathPreservingView).toHaveBeenCalledTimes(1)
  })

  it('disables extent actions whose authoritative bounds do not exist', () => {
    setPreviewState('')
    useMachineControl.setState({ settings: {} })
    render(<ProgramPreview />)

    expect(screen.getByRole('button', { name: 'Fit machine extents' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Fit program extents' }).hasAttribute('disabled')).toBe(true)
  })
})
