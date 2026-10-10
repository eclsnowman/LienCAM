import { describe, expect, it } from 'vitest'
import { displayedFacetsOf } from '../../components/panels/PropertiesPanel'

describe('WO-1923 displayedFacetsOf', () => {
  it('maps source facet ids to renumbered displayed indices after an edit', () => {
    // source facet 1 was removed: displayed 0,1,2 are source 0,2,3
    expect(displayedFacetsOf({ sourceFacetIds: [0, 2, 3] }, [2, 3])).toEqual([1, 2])
  })
  it('is the identity on an unedited part and null without a snapshot', () => {
    expect(displayedFacetsOf({ sourceFacetIds: [0, 1, 2] }, [1])).toEqual([1])
    expect(displayedFacetsOf(null, [1])).toBeNull()
  })
})
