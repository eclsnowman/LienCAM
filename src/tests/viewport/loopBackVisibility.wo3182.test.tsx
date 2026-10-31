// @vitest-environment jsdom
//
// WO-3182: the toolpath legend must expose the same independent loop-back
// visibility control that CNCViewport already applies to its role group.

import * as THREE from 'three'
import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { asNumber } from '../../theme/viewportColors'
import type { ToolpathMove } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ViewportOverlay } = await import('../../components/viewport/ViewportOverlay')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')

const LOOP_BACK_MOVES: ToolpathMove[] = [
  { type: 'feed', x: 0, y: 0, z: -1, role: 'cut' },
  { type: 'feed', x: 1, y: 0, z: -1, role: 'loop_back' },
  { type: 'feed', x: 2, y: 0, z: -1, role: 'loop_back' },
]

function methodOnlyViewport() {
  const viewport = Object.create(CNCViewport.prototype) as unknown as
    Pick<CNCViewport, 'renderToolpath' | 'setHiddenToolpathRoles'> & Record<string, unknown>
  viewport.toolpathGroup = new THREE.Group()
  viewport.toolpathRoleLines = new Map<string, THREE.Object3D>()
  viewport.toolpathPickBodies = []
  return viewport
}

beforeEach(() => {
  act(() => {
    useCamStore.setState(state => ({
      project: {
        ...state.project,
        activeSetupId: 'loop-back-setup',
        activeOperationId: 'loop-back-op',
        setups: [{
          id: 'loop-back-setup',
          name: 'Loop-back visibility fixture',
          operations: [{
            id: 'loop-back-op',
            enabled: true,
            status: 'ready',
            params: {},
            toolpathMoves: LOOP_BACK_MOVES,
          }],
        }] as any,
      },
      viewer: {
        ...state.viewer,
        mode: 'toolpath',
        hiddenToolpathRoles: [],
        showRoughingPreview: false,
      },
    }))
    useUiPrefs.setState({ tpLegendExpanded: true })
  })
})

describe('WO-3182 loop-back visibility', () => {
  it('mounts an independent Loop-back eye in the production legend', () => {
    render(<ViewportOverlay interactionMode="normal" />)

    const list = screen.getByTestId('tp-legend-list')
    const loopBack = Array.from(list.querySelectorAll('.tp-legend-toggle'))
      .find((item) => item.textContent?.includes('Loop-back'))
    expect(loopBack).toBeDefined()
    expect(screen.getByTestId('tp-legend-chip-badge').textContent).toBe('2')

    act(() => { fireEvent.click(loopBack!) })
    expect(useCamStore.getState().viewer.hiddenToolpathRoles).toEqual(['loop_back'])
    expect(screen.getByTestId('tp-legend-chip-badge').textContent).toBe('1')
  })

  it('filters the actual loop-back render group and uses its distinct display color', () => {
    const viewport = methodOnlyViewport()
    viewport.renderToolpath(LOOP_BACK_MOVES, true)

    const group = (viewport.toolpathRoleLines as Map<string, THREE.Object3D>).get('loop_back')
    expect(group).toBeDefined()
    expect(group!.visible).toBe(true)
    const line = group as THREE.LineSegments
    expect((line.material as THREE.LineBasicMaterial).color.getHex()).toBe(asNumber('--vp-wcs-origin'))

    viewport.setHiddenToolpathRoles(new Set(['loop_back']))
    expect(group!.visible).toBe(false)
    viewport.setHiddenToolpathRoles(new Set())
    expect(group!.visible).toBe(true)
  })
})
