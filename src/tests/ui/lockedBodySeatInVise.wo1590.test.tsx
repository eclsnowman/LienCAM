// @vitest-environment jsdom
//
// WO-1590 (mating S0), decide-and-log finding: the fix round's "seat command"
// half of the audit's named defect landed on `SeatInViseCommand.tsx`, a modal
// that is never imported/rendered anywhere in the app (grep confirms it has
// no live import site). The LIVE seat command is `SeatInViseStrip.tsx`
// (mounted unconditionally by `Viewport.tsx`), which still called
// `getVp()?.setPartTransform?.(...)` unconditionally right after
// `updateGeometryTransform`, the identical stomp-the-refused-pose bug -
// untouched by any previous round and unnoticed by either audit pass.
//
// The store-level fix for the Properties-panel defect (queueMicrotask the
// restore in `updateGeometryTransform`, src/store/index.ts) closes this path
// too, for free: the restore now runs after ANY caller's synchronous code,
// including this strip's own unconditional setPartTransform call. This test
// drives the real, live `SeatInViseStrip` component end to end and proves it.

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Vec3 } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => new ArrayBuffer(84)),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { SeatInViseStrip, useSeatInViseUi } = await import('../../components/viewport/SeatInViseStrip')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

function box(id: string, name: string, min: Vec3, max: Vec3, position: Vec3, rotation: Vec3): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { ...min }, max: { ...max },
      size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
      center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    },
    position, rotation, loaded: true,
  } as ImportedGeometry
}

const PART_BB = { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 30, z: 20 } }
const PART_POSE = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }
const PART = box('part', 'Bracket', PART_BB.min, PART_BB.max, PART_POSE.position, PART_POSE.rotation)

const VISE_BB = { min: { x: -30, y: -20, z: 0 }, max: { x: 0, y: 20, z: 60 } }
const VISE_START_POSE = { position: { x: 90, y: -2, z: 5 }, rotation: { x: 0, y: 0, z: 5 } }
const VISE = box('vise', 'Kurt vise', VISE_BB.min, VISE_BB.max, VISE_START_POSE.position, VISE_START_POSE.rotation)

function viseOf(): ImportedGeometry {
  return useCamStore.getState().project.geometry.find((g) => g.id === 'vise')!
}

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.getState().addGeometry(PART)
    useCamStore.getState().addGeometry(VISE)
    useCamStore.getState().setGeometryWorkholding('vise', true)
    useCamStore.getState().setGeometryLocked('vise', true)
  })
  act(() => { useSeatInViseUi.getState().closeSeatInVise() })
})

describe('WO-1590: Seat in vise refuses to move a LOCKED workholding body on screen', () => {
  it('the live SeatInViseStrip does not leave the vise at the seated pose after the store refuses it', async () => {
    const setPartTransform = vi.fn()
    ;(window as unknown as Record<string, unknown>).__cncViewport = { setPartTransform }

    try {
      act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })
      render(<SeatInViseStrip />)

      fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: 'part' } })
      fireEvent.click(screen.getByTestId('seat-in-vise-run'))

      // The store held (data never moved)...
      expect(viseOf().position).toEqual(VISE_START_POSE.position)
      expect(viseOf().rotation).toEqual(VISE_START_POSE.rotation)

      // ...and the strip's own unconditional setPartTransform call (the exact
      // shape SeatInViseCommand.tsx had before this order's fix round, still
      // present here because that round edited the wrong, unrendered file)
      // must not win the race: after the microtask restore runs, the LAST
      // pose the viewport was told is the vise's held position, not a seated
      // one it never actually reached.
      await act(async () => { await Promise.resolve() })
      expect(setPartTransform).toHaveBeenLastCalledWith(
        'vise', VISE_START_POSE.position, VISE_START_POSE.rotation,
      )
    } finally {
      delete (window as unknown as Record<string, unknown>).__cncViewport
    }
  })
})
