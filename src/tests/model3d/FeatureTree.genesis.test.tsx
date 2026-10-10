// @vitest-environment jsdom
//
// WO SKC-15, acceptance criterion 1, UI half: "Tree shows Origin + XY/XZ/YZ above features; each
// selectable/hoverable with viewport feedback; suppress/delete/reorder/rollback each refuse by name."
//
// The DAG half lives in src/tests/doc/genesisNodes.test.ts (the mutations refuse by name). THIS file
// drives the REAL FeatureTree through React Testing Library (render-gate rule: never a store proxy),
// and proves the UI never even OFFERS the affordance -- a user must not get a Delete item that would
// only end in a GenesisNodeError.
import { useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FeatureTree } from '../../components/model3d/tree'
import {
  BASE_PLANE_XY_NODE_ID,
  BASE_PLANE_XZ_NODE_ID,
  BASE_PLANE_YZ_NODE_ID,
  CommandHistory,
  FeatureDag,
  GENESIS_NODE_IDS,
  ORIGIN_NODE_ID,
  markerInsertIndex,
} from '../../doc'
import { seedGenesisNodes } from '../../components/model3d/workbench/basePlanes'

afterEach(cleanup)

const FEATURE = 'F1'

function seededDag(): FeatureDag {
  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  dag.insertNode({ id: FEATURE, kind: 'feature', consumes: [], payload: { name: 'Extrude 1' } })
  return dag
}

/** Mirrors SolidsWorkbenchPage's own wiring of the controls this WO gates. */
function Harness({ dag, onDelete }: { dag: FeatureDag; onDelete?: (id: string) => void }) {
  const [, bump] = useState(0)
  const history = new CommandHistory(dag)
  return (
    <FeatureTree
      dag={dag}
      del={{ consumersOf: (id) => dag.transitiveConsumersOf(id), onDelete: onDelete ?? (() => bump((v) => v + 1)) }}
      suppress={{ onToggleSuppress: () => bump((v) => v + 1) }}
      reorder={{ checkReorder: (id, i) => dag.checkReorder(id, i), onReorder: () => bump((v) => v + 1) }}
      rollback={{ marker: dag.getRollbackMarker(), onMoveMarker: () => bump((v) => v + 1) }}
      onSelect={() => history.canUndo()}
    />
  )
}

const rowOf = (id: string): HTMLElement => screen.getByTestId(`feature-row-${id}`)

describe('WO SKC-15: the tree presents Origin + XY/XZ/YZ above every feature', () => {
  it('renders all four genesis rows, plus the feature', () => {
    render(<Harness dag={seededDag()} />)
    for (const id of GENESIS_NODE_IDS) expect(rowOf(id)).toBeTruthy()
    expect(rowOf(FEATURE)).toBeTruthy()
  })

  it('they render ABOVE the features, in Origin -> XY -> XZ -> YZ order', () => {
    const { container } = render(<Harness dag={seededDag()} />)
    // `[role="treeitem"]` is load-bearing: the bare data-testid prefix also matches each row's
    // `feature-row-suppress-<id>` button, which would silently inflate this list.
    const ids = [...container.querySelectorAll('[data-testid^="feature-row-"][role="treeitem"]')].map((el) =>
      (el as HTMLElement).dataset.testid!.replace('feature-row-', ''),
    )
    expect(ids).toEqual([...GENESIS_NODE_IDS, FEATURE])
  })

  it('the base planes carry their own names, not raw node ids', () => {
    render(<Harness dag={seededDag()} />)
    expect(screen.getByText('Origin')).toBeTruthy()
    expect(screen.getByText('XY')).toBeTruthy()
    expect(screen.getByText('XZ')).toBeTruthy()
    expect(screen.getByText('YZ')).toBeTruthy()
  })

  it('a base plane is NOT folded under the sketch that consumes it (only face-plane datums fold)', () => {
    const dag = seededDag()
    dag.insertNode({
      id: 'SK1', kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID],
      payload: { name: 'Sketch 1', planeNodeId: BASE_PLANE_XY_NODE_ID },
    })
    const { container } = render(<Harness dag={dag} />)
    // `[role="treeitem"]` is load-bearing: the bare data-testid prefix also matches each row's
    // `feature-row-suppress-<id>` button, which would silently inflate this list.
    const ids = [...container.querySelectorAll('[data-testid^="feature-row-"][role="treeitem"]')].map((el) =>
      (el as HTMLElement).dataset.testid!.replace('feature-row-', ''),
    )
    // XY stays at index 1, above the features -- never re-parented beneath SK1.
    expect(ids.slice(0, GENESIS_NODE_IDS.length)).toEqual([...GENESIS_NODE_IDS])
    expect(ids).toContain('SK1')
  })
})

describe('WO SKC-15: the tree offers no destructive affordance on a genesis row', () => {
  it.each(GENESIS_NODE_IDS)('%s has no suppress button (an ordinary feature does)', (id) => {
    render(<Harness dag={seededDag()} />)
    expect(screen.queryByTestId(`feature-row-suppress-${id}`)).toBeNull()
    // Non-vacuity: the button exists for a real feature, so its absence above means something.
    expect(screen.queryByTestId(`feature-row-suppress-${FEATURE}`)).not.toBeNull()
  })

  it.each(GENESIS_NODE_IDS)('%s is not draggable (an ordinary feature is)', (id) => {
    render(<Harness dag={seededDag()} />)
    expect(rowOf(id).getAttribute('draggable')).not.toBe('true')
    expect(rowOf(FEATURE).getAttribute('draggable')).toBe('true')
  })

  it.each(GENESIS_NODE_IDS)('pressing Delete on a focused %s row opens no confirm dialog', (id) => {
    let deleted: string | null = null
    render(<Harness dag={seededDag()} onDelete={(nid) => { deleted = nid }} />)
    fireEvent.keyDown(rowOf(id), { key: 'Delete' })
    expect(screen.queryByText(/Delete/i)).toBeNull()
    expect(deleted).toBeNull()
  })

  it('pressing Delete on a real feature row DOES open the confirm dialog (non-vacuity)', () => {
    render(<Harness dag={seededDag()} />)
    expect(screen.getAllByText(/Extrude 1/)).toHaveLength(1) // just the row label
    fireEvent.keyDown(rowOf(FEATURE), { key: 'Delete' })
    // The dialog names the target, so the label now appears twice: row + confirm.
    expect(screen.getAllByText(/Extrude 1/).length).toBeGreaterThan(1)
  })

  it.each(GENESIS_NODE_IDS)("%s's context menu offers neither Delete nor Suppress", (id) => {
    render(<Harness dag={seededDag()} />)
    fireEvent.keyDown(rowOf(id), { key: 'F10', shiftKey: true })
    expect(screen.queryByText(/^Delete/)).toBeNull()
    expect(screen.queryByText(/Suppress|Unsuppress/)).toBeNull()
  })

  it("a real feature's context menu DOES offer Delete and Suppress (non-vacuity)", () => {
    render(<Harness dag={seededDag()} />)
    fireEvent.keyDown(rowOf(FEATURE), { key: 'F10', shiftKey: true })
    expect(screen.queryByText(/^Delete/)).not.toBeNull()
    expect(screen.queryByText(/Suppress|Unsuppress/)).not.toBeNull()
  })
})

describe('WO SKC-15: rollback never sweeps the genesis rows', () => {
  it("the rollback marker's 'start' slot resolves below the genesis run", () => {
    const dag = seededDag()
    expect(markerInsertIndex(dag.featureOrder(), { kind: 'start' })).toBe(GENESIS_NODE_IDS.length)
  })

  it("with the marker at 'start', no genesis row renders as rolled back", () => {
    const dag = seededDag()
    dag.setRollbackMarker({ kind: 'start' })
    render(<Harness dag={dag} />)
    for (const id of GENESIS_NODE_IDS) {
      expect(rowOf(id).textContent, `${id} must not read as rolled back`).not.toContain('rolled back')
    }
    expect(rowOf(FEATURE).textContent).toContain('rolled back')
  })
})

describe('WO SKC-15: the base planes are selectable (viewport feedback rides selection)', () => {
  it.each([ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID])(
    'clicking %s reports it to onSelect',
    (id) => {
      const selected: string[] = []
      const dag = seededDag()
      render(<FeatureTree dag={dag} onSelect={(nid) => selected.push(nid)} />)
      fireEvent.click(rowOf(id))
      expect(selected).toContain(id)
    },
  )
})
