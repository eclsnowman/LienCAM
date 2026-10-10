// WO-1825: perspectiveMode was write-only (typed + stored, zero consumers) -
// architect ruling was DELETE, not honour. This pins the deletion: the default
// viewer state must never carry the key again, silently or otherwise.

import { describe, it, expect } from 'vitest'
import { useCamStore } from '../../store'

describe('WO-1825 perspectiveMode deletion', () => {
  it('the default viewer state has no perspectiveMode key', () => {
    const viewer = useCamStore.getState().viewer
    expect('perspectiveMode' in viewer).toBe(false)
    expect((viewer as unknown as Record<string, unknown>).perspectiveMode).toBeUndefined()
  })
})
