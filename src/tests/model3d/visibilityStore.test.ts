// WO UI-4 acceptance #4: hide/isolate/show-all state machine.

import { describe, it, expect } from 'vitest'
import { VisibilityStore } from '../../components/model3d/visibility'

describe('VisibilityStore', () => {
  it('per-body hide toggles independently of other bodies', () => {
    const store = new VisibilityStore()
    expect(store.isBodyVisible('a')).toBe(true)
    store.toggleBodyHidden('a')
    expect(store.isBodyVisible('a')).toBe(false)
    expect(store.isBodyVisible('b')).toBe(true)
    store.toggleBodyHidden('a')
    expect(store.isBodyVisible('a')).toBe(true)
  })

  it('per-face hide is scoped by owning-body visibility too', () => {
    const store = new VisibilityStore()
    store.setFaceHidden('f1', true)
    expect(store.isFaceVisible('bodyA', 'f1')).toBe(false)
    expect(store.isFaceVisible('bodyA', 'f2')).toBe(true)
    store.toggleBodyHidden('bodyA')
    expect(store.isFaceVisible('bodyA', 'f2')).toBe(false) // body hidden wins
  })

  it('isolateIds(bodyIds) shows only those bodies', () => {
    const store = new VisibilityStore()
    store.isolateIds(['a'])
    expect(store.isBodyVisible('a')).toBe(true)
    expect(store.isBodyVisible('b')).toBe(false)
    store.clearIsolate()
    expect(store.isBodyVisible('b')).toBe(true)
  })

  it('isolateIds(bodyIds, faceIds) shows only those faces within the isolated body', () => {
    const store = new VisibilityStore()
    store.isolateIds(['a'], ['f1'])
    expect(store.isFaceVisible('a', 'f1')).toBe(true)
    expect(store.isFaceVisible('a', 'f2')).toBe(false)
    expect(store.isFaceVisible('b', 'f1')).toBe(false) // wrong body, not isolated
  })

  it('showAll clears explicit hides AND isolate', () => {
    const store = new VisibilityStore()
    store.toggleBodyHidden('a')
    store.setFaceHidden('f1', true)
    store.isolateIds(['b'])
    store.showAll()
    expect(store.isBodyVisible('a')).toBe(true)
    expect(store.isFaceVisible('a', 'f1')).toBe(true)
    expect(store.isBodyVisible('c')).toBe(true) // no longer isolate-restricted
  })

  it('notifies subscribers only on an actual state change', () => {
    const store = new VisibilityStore()
    let notifications = 0
    store.subscribe(() => notifications++)
    store.toggleBodyHidden('a')
    expect(notifications).toBe(1)
    store.setBodyHidden('a', true) // already hidden -- no-op
    expect(notifications).toBe(1)
    store.showAll()
    expect(notifications).toBe(2)
  })
})
