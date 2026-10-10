// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { useState } from 'react'
import { CommandHistory, FeatureDag } from '../../doc'
import {
  HoleDialog,
  HolePointPickerOverlay,
  type HoleSnapCandidate,
} from '../../components/model3d/dialogs/HoleDialog'
import type { Vec3 } from '../../geom/geom-service'

afterEach(cleanup)

const CANDIDATES: HoleSnapCandidate[] = [
  {
    id: 'sketch-a:point-a',
    label: 'Point A (sketch-a)',
    world: { x: 24, y: 18, z: 10 },
  },
  {
    id: 'sketch-b:point-b',
    label: 'Point B (sketch-b)',
    world: { x: 42, y: 31, z: 10 },
  },
]

function Harness() {
  const [seed, setSeed] = useState<Vec3>({ x: 5, y: 6, z: 10 })
  const [selectedId, setSelectedId] = useState('')
  const dag = new FeatureDag()
  dag.insertNode({
    id: 'F1',
    kind: 'feature',
    payload: { opType: 'extrude', name: 'Plate' },
  })
  const history = new CommandHistory(dag)

  const updateSeed = (next: Vec3, snapId: string): void => {
    setSeed(next)
    setSelectedId(snapId)
  }

  return (
    <div style={{ position: 'relative', width: 400, height: 300 }}>
      <HolePointPickerOverlay
        candidates={CANDIDATES}
        selectedId={selectedId}
        projectToCanvas={(point) => ({ x: point.x, y: point.y })}
        onPick={(candidate) => updateSeed(candidate.world, candidate.id)}
      />
      <HoleDialog
        dag={dag}
        history={history}
        mode="create"
        ownerId="F1"
        faceId="F1:top"
        origin={seed}
        normal={{ x: 0, y: 0, z: 1 }}
        snapCandidates={CANDIDATES}
        selectedSnapId={selectedId}
        onSeedChange={updateSeed}
        onApplied={vi.fn()}
        onClose={vi.fn()}
      />
    </div>
  )
}

function seedValue(axis: 'x' | 'y' | 'z'): number {
  const input = screen
    .getByTestId(`hole-seed-${axis}`)
    .querySelector('input') as HTMLInputElement
  return Number(input.value)
}

describe('UI-67 Hole sketch-point viewport picker', () => {
  it('projects eligible points, gives hover feedback, and shares seed state with the list fallback', async () => {
    render(<Harness />)

    expect(screen.getByTestId('dialog-shell-backdrop').className)
      .toContain('modal-backdrop-transparent')
    expect(screen.getByTestId('hole-viewport-point-hint').textContent)
      .toMatch(/highlighted sketch point/i)

    const pointB = await waitFor(() =>
      screen.getByTestId('hole-point-pick-sketch-b:point-b'))
    expect(pointB.style.left).toBe('42px')
    expect(pointB.style.top).toBe('31px')

    fireEvent.pointerEnter(pointB)
    expect(pointB.dataset.hovered).toBe('true')
    fireEvent.click(pointB)

    expect(seedValue('x')).toBe(42)
    expect(seedValue('y')).toBe(31)
    expect(seedValue('z')).toBe(10)
    expect((screen.getByTestId('hole-snap-select') as HTMLSelectElement).value)
      .toBe('sketch-b:point-b')
    expect(pointB.className).toContain('hole-point-pick-target--selected')

    fireEvent.change(screen.getByTestId('hole-snap-select'), {
      target: { value: 'sketch-a:point-a' },
    })
    expect(seedValue('x')).toBe(24)
    expect(seedValue('y')).toBe(18)
  })
})
