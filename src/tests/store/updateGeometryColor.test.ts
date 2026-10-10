import { beforeEach, describe, expect, it } from 'vitest'
import type { ImportedGeometry } from '../../types'
import { useCamStore } from '../../store'

function geometry(id: string, color?: string): ImportedGeometry {
  return {
    id,
    name: id,
    filename: id,
    type: 'model',
    format: 'model',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 },
      center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    color,
  }
}

describe('updateGeometryColor', () => {
  beforeEach(() => {
    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        geometry: [geometry('modeled-body', '#123456'), geometry('other-body', '#abcdef')],
      },
      projectHistory: [],
      sketchHistory: [],
      projectFuture: [],
      sketchFuture: [],
      canUndo: false,
      canRedo: false,
    }))
  })

  it('sets and clears the authoritative ImportedGeometry color without changing sibling rows', () => {
    useCamStore.getState().updateGeometryColor('modeled-body', '#ff8800')

    expect(useCamStore.getState().project.geometry).toEqual([
      geometry('modeled-body', '#ff8800'),
      geometry('other-body', '#abcdef'),
    ])

    useCamStore.getState().updateGeometryColor('modeled-body', undefined)

    expect(useCamStore.getState().project.geometry).toEqual([
      geometry('modeled-body'),
      geometry('other-body', '#abcdef'),
    ])
  })
})
