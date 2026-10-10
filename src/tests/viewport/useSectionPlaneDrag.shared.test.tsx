// @vitest-environment jsdom

import { useCallback, useMemo, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSectionPlaneDrag } from '../../hooks/useSectionPlaneDrag'

function Harness() {
  const [surface, setSurface] = useState<HTMLDivElement | null>(null)
  const [position, setPosition] = useState(0)
  const surfaceRef = useCallback((node: HTMLDivElement | null) => setSurface(node), [])
  const controller = useMemo(() => ({
    state: { dragEnabled: true, pos: position, range: { min: -200, max: 200 } },
    setPos: setPosition,
  }), [position])

  useSectionPlaneDrag({ domElement: surface, enabled: true, section: controller, exclusive: true })

  return (
    <>
      <div ref={surfaceRef} data-testid="surface" />
      <output data-testid="position">{position}</output>
    </>
  )
}

describe('shared section-plane viewport drag', () => {
  it('moves and clamps the plane while exclusively owning an armed CAM drag', () => {
    render(<Harness />)
    const surface = screen.getByTestId('surface')
    Object.defineProperty(surface, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200 }),
    })
    const competingViewportHandler = vi.fn()
    surface.addEventListener('pointerdown', competingViewportHandler)

    act(() => {
      fireEvent.pointerDown(surface, { pointerId: 7, clientY: 100 })
      fireEvent.pointerMove(surface, { pointerId: 7, clientY: 150 })
    })
    expect(screen.getByTestId('position').textContent).toBe('-100')
    expect(competingViewportHandler).not.toHaveBeenCalled()

    act(() => { fireEvent.pointerMove(surface, { pointerId: 7, clientY: 500 }) })
    expect(screen.getByTestId('position').textContent).toBe('-200')
    act(() => { fireEvent.pointerUp(surface, { pointerId: 7 }) })
  })
})
