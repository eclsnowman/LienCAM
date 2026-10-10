// @vitest-environment jsdom
//
// SKC-H2 criterion 3 / BK-58 (coordination/BACKLOG.md): reproduces the React console warning
// "Encountered two children with the same key, `coincident`" first seen during an INT-4 harness
// run (coordination/reports/INT-4.report.json) while adding distance constraints in the real
// Sketch3d Lab.
//
// Root cause: the auto-constrain inference panel in Sketch3dLabPage.tsx keys its candidate
// buttons by `candidate.kind`, not a unique id. inferLineDrawCandidates
// (src/sketch3d/inference.ts) independently checks the drawn line's 'start' AND 'end' site for
// a nearby existing point, and each site can produce its OWN 'coincident'-kind candidate - so
// closing a loop (both endpoints of the closing line snapping to two different existing points)
// naturally offers 2 candidates that share kind 'coincident' but have different
// `candidate.constraint.id`s. Rendering them side by side with `key={candidate.kind}` collides.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { Sketch3dLabPage } from '../../components/sketch3dlab/Sketch3dLabPage'
import { worldToScreen } from '../../components/sketch3dlab/geometry2d'
import type { Sketch3dVec2 } from '../../sketch3d'

afterEach(cleanup)

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('sketch3dlab-status').textContent).toBe('ready'), { timeout: 15_000 })
}

function click(world: Sketch3dVec2): void {
  const canvas = screen.getByTestId('sketch3dlab-canvas')
  const { x, y } = worldToScreen(world)
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y })
}

function useTool(tool: 'select' | 'line' | 'circle' | 'arc' | 'drag'): void {
  fireEvent.click(screen.getByTestId(`sketch3dlab-tool-${tool}`))
}

function duplicateKeyMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((args) => args.map((a) => String(a)).join(' '))
    .filter((msg) => /same key/i.test(msg) && /coincident/.test(msg))
}

describe('Sketch3dLabPage BK-58: no duplicate React key when 2 coincident candidates are offered at once', () => {
  it('closing a triangle (both endpoints of the closing line snap to existing points) offers 2 simultaneous coincident candidates with no duplicate-key console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Sketch3dLabPage />)
    await ready()

    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 10, y: 0 }) // line1: horizontal
    await waitFor(() => expect(Number(screen.getByTestId('sketch3dlab-entity-count').textContent)).toBe(1))

    useTool('line')
    click({ x: 10.3, y: 0.3 }) // near line1.end (dist ~0.42)
    click({ x: 10.3, y: 10.3 }) // line2: roughly vertical
    await waitFor(() => expect(Number(screen.getByTestId('sketch3dlab-entity-count').textContent)).toBe(2))

    useTool('line')
    click({ x: 10.5, y: 10.5 }) // line3 start - near line2.end (dist ~0.28)
    click({ x: 0.2, y: 0.2 }) // line3 end - near line1.start (dist ~0.28), closing the loop
    await waitFor(() => expect(Number(screen.getByTestId('sketch3dlab-entity-count').textContent)).toBe(3))

    // Precondition: 2 simultaneous 'coincident' candidates actually rendered (data-testid is
    // kind-based like the buggy key, so this proves the collision scenario really occurred).
    await screen.findByTestId('sketch3dlab-inference-panel')
    expect(screen.getAllByTestId('sketch3dlab-infer-coincident').length).toBe(2)

    expect(duplicateKeyMessages(errorSpy)).toEqual([])
    errorSpy.mockRestore()
  })
})
