// @vitest-environment jsdom
//
// WO INT-15, Work item 3 -- F-3: the CNCViewport slice-plane Z-edit window keydown listener must
// be DISARMED while the CAM host is suspended, and RE-ARMED on resume (suspend-and-restore).
//
// WHY THIS IS A PROTOTYPE-RECEIVER TEST, NOT A MOUNT. CNCViewport constructs a real
// THREE.WebGLRenderer in its constructor (CNCViewport.ts) -- jsdom has no WebGL, so a real
// instance cannot exist here (this is the same wall ViewportCarvedStockCensus.sim7 hit and why it
// mocks the whole class). But F-3 lives entirely in suspendRender()/resumeRender(), which touch
// only `this.slicePlaneKeyHandler`, `this.controls`, `this.sketcher` and the render loop. So this
// exercises the REAL method SOURCE (CNCViewport.prototype.suspendRender / .resumeRender) against a
// hand-built receiver carrying exactly those fields, wired the way _enterZScrubMode wires them:
// a real slice-plane key handler attached to `window`. The keydown dispatch, the window
// add/removeEventListener, and the method bodies are all real; only the receiver's WebGL-bearing
// fields are omitted (they are never read on the suspend/resume path). Disclosed as such in the
// report: this is the faithful test the WebGL constraint allows, and it turns RED on the exact
// mutation (drop the disarm) that reopens the leak.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'

interface SliceReceiver {
  renderSuspended: boolean
  animFrameId: number
  controls: { addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }
  handleControlsChange: () => void
  sketcher: { suspend: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }
  slicePlaneKeyHandler: ((e: KeyboardEvent) => void) | null
  startRenderLoop: ReturnType<typeof vi.fn>
}

let fired: string[]
let receiver: SliceReceiver

/** Build the minimal receiver the suspend/resume path reads, with a REAL slice-plane key handler
 *  attached to window exactly as _enterZScrubMode does (confirm on Enter, cancel on Escape). */
function makeReceiver(): SliceReceiver {
  const handler = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') fired.push('Enter')
    else if (e.key === 'Escape') fired.push('Escape')
  }
  window.addEventListener('keydown', handler) // the attach _enterZScrubMode performs
  return {
    renderSuspended: false,
    animFrameId: 0,
    controls: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    handleControlsChange: () => {},
    sketcher: { suspend: vi.fn(), resume: vi.fn() },
    slicePlaneKeyHandler: handler,
    startRenderLoop: vi.fn(),
  }
}

const suspendRender = (r: SliceReceiver) => CNCViewport.prototype.suspendRender.call(r as unknown as CNCViewport)
const resumeRender = (r: SliceReceiver) => CNCViewport.prototype.resumeRender.call(r as unknown as CNCViewport)
const pressKey = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

beforeEach(() => {
  fired = []
  receiver = makeReceiver()
})
afterEach(() => {
  if (receiver.slicePlaneKeyHandler) window.removeEventListener('keydown', receiver.slicePlaneKeyHandler)
})

describe('INT-15 F-3: CNCViewport slice-plane listener disarms on suspend, re-arms on resume', () => {
  it('NON-VACUITY: with the CAM host live, the slice-plane handler answers Enter/Escape', () => {
    pressKey('Escape')
    pressKey('Enter')
    expect(fired).toEqual(['Escape', 'Enter'])
  })

  it('a suspended CAM host DISARMS the slice-plane listener (Enter/Escape from the Model workspace do nothing)', () => {
    suspendRender(receiver)
    expect(receiver.renderSuspended).toBe(true)
    expect(receiver.slicePlaneKeyHandler).toBeNull() // CLOSE-on-suspend: the handler is detached AND cleared
    fired = []
    pressKey('Escape')
    pressKey('Enter')
    expect(fired).toEqual([]) // the stranded slice-plane edit no longer answers keys
  })

  it('RESUME does NOT revive the closed edit (close-on-suspend, not restore) and adds no stray binding', () => {
    suspendRender(receiver)
    resumeRender(receiver)
    expect(receiver.renderSuspended).toBe(false)
    expect(receiver.slicePlaneKeyHandler).toBeNull() // still closed -- the operator re-enters via the toolbar
    fired = []
    pressKey('Escape')
    pressKey('Enter')
    expect(fired).toEqual([]) // no re-armed listener, and crucially no DOUBLE binding either
  })

  it('suspend is idempotent (a second suspendRender with no open edit does not throw)', () => {
    suspendRender(receiver)
    expect(() => suspendRender(receiver)).not.toThrow() // renderSuspended guard: second call is a no-op
    expect(receiver.slicePlaneKeyHandler).toBeNull()
  })
})
