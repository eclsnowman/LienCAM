// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import {
  DIRECT_EDIT_BODY_OP_TYPES,
  WORKBENCH_BODY_OP_DEFINITIONS,
} from '../../components/model3d/bodyLineage'
import { createDirectEditFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { FeatureTree } from '../../components/model3d/tree'

afterEach(cleanup)

describe('UI-71 direct-edit feature rows', () => {
  it('derives the direct-edit domain from the executor registry and renders every command as undoable history', () => {
    expect(DIRECT_EDIT_BODY_OP_TYPES).toEqual(
      WORKBENCH_BODY_OP_DEFINITIONS
        .filter((definition) => definition.historyRole === 'direct-edit')
        .map((definition) => definition.opType),
    )
    expect(DIRECT_EDIT_BODY_OP_TYPES).toEqual(expect.arrayContaining(['pushPull', 'resizeHole', 'defeature']))

    const dag = new FeatureDag()
    const history = new CommandHistory(dag)
    dag.insertNode({ id: 'BASE', kind: 'feature', payload: { opType: 'extrude', name: 'Base' } })

    let ownerId = 'BASE'
    DIRECT_EDIT_BODY_OP_TYPES.forEach((opType, index) => {
      const id = `DE${index + 1}`
      history.execute(createDirectEditFeatureCommand(dag, {
        id,
        kind: 'feature',
        consumes: [ownerId],
        payload: { opType, ownerId, name: `${opType} row` },
      }))
      ownerId = id
    })

    render(<FeatureTree dag={dag} />)
    DIRECT_EDIT_BODY_OP_TYPES.forEach((opType, index) => {
      expect(screen.getByTestId(`feature-row-DE${index + 1}`).textContent).toContain(`${opType} row`)
    })

    const tailId = `DE${DIRECT_EDIT_BODY_OP_TYPES.length}`
    expect(history.undo()).toBe(true)
    expect(dag.getNode(tailId)).toBeUndefined()
    expect(history.redo()).toBe(true)
    expect(dag.getNode(tailId)?.payload.opType).toBe(DIRECT_EDIT_BODY_OP_TYPES.at(-1))
  })

  it('refuses non-direct operations through the direct-edit command entry point', () => {
    const dag = new FeatureDag()
    for (const definition of WORKBENCH_BODY_OP_DEFINITIONS.filter(({ historyRole }) => historyRole !== 'direct-edit')) {
      expect(() => createDirectEditFeatureCommand(dag, {
        id: `not-direct-${definition.opType}`,
        kind: 'feature',
        payload: { opType: definition.opType },
      })).toThrow(/registered direct-edit feature/)
    }
  })
})
