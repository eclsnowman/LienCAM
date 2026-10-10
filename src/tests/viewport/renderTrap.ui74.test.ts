// WO UI-74-R4 -- the ruled render trap, and its two blockers, proved to CAN-FAIL
// without a browser.
//
// The mechanism (tools/capture/lib/ui74-render-trap.mjs) references only
// globalThis, Object, WeakMap and Error, so the SAME function that the census
// injects at page bootstrap runs here in node against a mock WebGLRenderer. That
// is what makes the version-drift tripwire (WO item 5) and R2 BLOCKER 1 (WO item
// 2) testable without a GPU:
//
//   - THREE 0.184 SHAPE: the constructor assigns `this.render = fn` per instance.
//     The trap's Object.prototype accessor intercepts that assignment, captures
//     the renderer AT CONSTRUCTION, migrates onto the class prototype, and the
//     wrap is what `renderer.render` returns from the FIRST read. First call
//     observed -> constructedCount grows, calls > 0.
//   - DRIFT SHAPE: `render` is a PROTOTYPE METHOD (no per-instance assignment).
//     The setter never fires, constructedCount stays 0, and evalTrapDrift STOPS
//     by name (STOP-VERSION-DRIFT / STOP-NO-CAPTURE) rather than enumerating
//     nothing.
//   - BLOCKER 1: evalRendererFirstCall reddens for a live wrapped renderer whose
//     GL context DREW while the census watched but whose wrap saw ZERO calls (the
//     bypass R2's check 9 accepted on wrapped===true alone), and passes when the
//     surface either drew and was observed, or drew nothing at all.
//
// Every table asserts BOTH directions; tools/diag/ui74-r4-trap-mutation.mjs
// reinjects the old bugs and requires the named rows here to redden, so this is a
// gate that can fail, not a table that can only pass.

import { describe, it, expect, afterEach } from 'vitest'
import { RENDER_TRAP_INIT, evalTrapDrift, evalRendererFirstCall } from '../support/ui74-render-trap.mjs'

// The trap installs a `render` accessor on Object.prototype and migrates it onto
// whichever class prototype constructs first. Vitest isolates modules per file,
// but within this file we run the trap several times, so each test resets the
// globals it touches. A leaked Object.prototype/prototype accessor would poison
// the next test exactly the way it would poison the app, so the cleanup is part
// of the proof that the trap is removable.
function resetTrapGlobals(...protos: object[]) {
  try { delete (Object.prototype as unknown as Record<string, unknown>).render } catch { /* ignore */ }
  for (const p of protos) { try { delete (p as Record<string, unknown>).render } catch { /* ignore */ } }
  try { delete (globalThis as unknown as Record<string, unknown>).__ui74Trap } catch { /* ignore */ }
}

// A camera/scene shaped like three's, enough for the wrap's observe() to record a
// distinct triple and spy near/far.
class MockCamera {
  isCamera = true
  type = 'OrthographicCamera'
  uuid: string
  near = 0.1
  far = 1000
  constructor(uuid: string) { this.uuid = uuid }
}
class MockScene { isObject3D = true }

// A renderer shaped EXACTLY like three's compiled constructor: `this.render = fn`
// is a PLAIN ASSIGNMENT (never a declared class field). That distinction is
// load-bearing -- a TS class field `render: any` compiles under
// useDefineForClassFields to Object.defineProperty(this, 'render', ...), a direct
// own-property DEFINE that bypasses a prototype setter, which three does NOT do.
// So the mock must assign, not define, or it would not exercise the real trap.
function makeThreeShapedRenderer(): new () => { isWebGLRenderer: boolean; render: (s: unknown, c: unknown) => unknown } {
  class WebGLRenderer {
    isWebGLRenderer = true
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(this as any).render = function (_scene: unknown, _camera: unknown) { return 'real' }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return WebGLRenderer as any
}

describe('UI-74-R4 render trap: three 0.184 shape (per-instance assignment)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Ctor: any
  afterEach(() => resetTrapGlobals(Ctor?.prototype))

  it('captures the renderer AT CONSTRUCTION and OBSERVES its FIRST render call', () => {
    RENDER_TRAP_INIT()
    Ctor = makeThreeShapedRenderer()
    const r = new Ctor()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trap = (globalThis as any).__ui74Trap
    trap.observing = true                                 // INSTALL_CENSUS opens the window

    expect(trap.constructedCount).toBe(1)                 // captured at construction
    expect(trap.migrated).toBe(true)                      // accessor now on the class prototype
    expect((r.render as { name: string }).name).toBe('ui74RenderWrap')
    expect(trap.records.get(r).calls).toBe(0)             // not yet rendered

    const cam = new MockCamera('cam-A'), scene = new MockScene()
    const out = (r.render as (s: unknown, c: unknown) => unknown)(scene, cam)
    expect(out).toBe('real')                              // original return, intact
    expect(trap.records.get(r).calls).toBe(1)             // FIRST call observed
    expect(trap.triples.size).toBe(1)
    expect(trap.cameras.get('cam-A').spied).toBe(true)
  })

  it('the OBSERVATION WINDOW: pre-install renders COUNT calls (BLOCKER 1) but are NOT enumerated (boot transients excluded)', () => {
    RENDER_TRAP_INIT()
    Ctor = makeThreeShapedRenderer()
    const r = new Ctor()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trap = (globalThis as any).__ui74Trap
    const cam = new MockCamera('cam-boot'), scene = new MockScene()

    // Window CLOSED (boot phase): the wrap still counts the call -- that is the
    // first-call proof -- but records NO verdict-bearing triple.
    ;(r.render as (s: unknown, c: unknown) => unknown)(scene, cam)
    expect(trap.records.get(r).calls).toBe(1)             // counted from construction
    expect(trap.triples.size).toBe(0)                     // NOT enumerated pre-install

    // Window OPEN (steady state): now it enumerates.
    trap.observing = true
    ;(r.render as (s: unknown, c: unknown) => unknown)(scene, cam)
    expect(trap.records.get(r).calls).toBe(2)
    expect(trap.triples.size).toBe(1)                     // enumerated once the window opened
  })

  it('leaves Object.prototype clean after migration (no `render` pollution, no `in` leak)', () => {
    RENDER_TRAP_INIT()
    Ctor = makeThreeShapedRenderer()
    const r = new Ctor() // construct: migrates the accessor onto the class prototype
    expect((r.render as { name: string }).name).toBe('ui74RenderWrap') // the getter returns the wrap
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'render')).toBeUndefined()
    expect('render' in ({} as Record<string, unknown>)).toBe(false)
    // A non-renderer assigned `.render` during use keeps a plain own data property.
    const plain: Record<string, unknown> = {}
    plain.render = 42
    expect(plain.render).toBe(42)
    expect(Object.getOwnPropertyDescriptor(plain, 'render')?.value).toBe(42)
  })

  it('retains DISTINCT (renderer, scene, camera) triples -- a second scene on the same camera is NOT overwritten (R2 BLOCKER 2)', () => {
    RENDER_TRAP_INIT()
    Ctor = makeThreeShapedRenderer()
    const r = new Ctor()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).__ui74Trap.observing = true      // INSTALL_CENSUS opens the window
    const cam = new MockCamera('cam-shared')
    const sceneA = new MockScene(), sceneB = new MockScene()
    ;(r.render as (s: unknown, c: unknown) => unknown)(sceneA, cam)
    ;(r.render as (s: unknown, c: unknown) => unknown)(sceneB, cam)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trap = (globalThis as any).__ui74Trap
    expect(trap.triples.size).toBe(2)                     // both scenes retained, not last-wins
    // Rendering sceneA again is the SAME triple, not a third.
    ;(r.render as (s: unknown, c: unknown) => unknown)(sceneA, cam)
    expect(trap.triples.size).toBe(2)
  })
})

describe('UI-74-R4 version-drift tripwire (WO item 5)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Ctor: any
  afterEach(() => resetTrapGlobals(Ctor?.prototype))

  it('STOPS by name when `render` is a PROTOTYPE METHOD -- the setter never fires', () => {
    RENDER_TRAP_INIT()
    // The drift shape: render on the prototype, NO per-instance assignment. This
    // is exactly "the own property deleted before construction" the WO names.
    class WebGLRendererDrift {
      isWebGLRenderer = true
      render(_scene: unknown, _camera: unknown) { return 'proto' }
    }
    Ctor = WebGLRendererDrift
    const d = new WebGLRendererDrift()
    d.render(new MockScene(), new MockCamera('cam-drift'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trap = (globalThis as any).__ui74Trap
    expect(trap.constructedCount).toBe(0)                 // setter never fired

    const verdict = evalTrapDrift({
      trapPresent: true, installed: true, constructedCount: trap.constructedCount,
      seedRendererPresent: true, seedRendererCaptured: false,
      seedProtoRenderKind: 'data-function', threeVersion: '0.184.0',
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.stop).toBe('STOP-VERSION-DRIFT')
    expect(verdict.why).toMatch(/VERSION-DRIFT TRIPWIRE FIRED/)
  })

  it('STOPS by name when zero renderers were captured though the page rendered', () => {
    const v = evalTrapDrift({
      trapPresent: true, installed: true, constructedCount: 0,
      seedRendererPresent: false, seedProtoRenderKind: null, threeVersion: '0.184.0',
    })
    expect(v.ok).toBe(false)
    expect(v.stop).toBe('STOP-NO-CAPTURE')
  })

  it('STOPS by name when the trap itself is absent (RENDER_TRAP_INIT never ran)', () => {
    const v = evalTrapDrift({ trapPresent: false, installed: false, threeVersion: '0.184.0' })
    expect(v.ok).toBe(false)
    expect(v.stop).toBe('STOP-TRAP-ABSENT')
  })

  it('STOPS by name when an exposed seed renderer escaped the trap', () => {
    const v = evalTrapDrift({
      trapPresent: true, installed: true, constructedCount: 3,
      seedRendererPresent: true, seedRendererCaptured: false,
      seedProtoRenderKind: 'accessor', threeVersion: '0.184.0',
    })
    expect(v.ok).toBe(false)
    expect(v.stop).toBe('STOP-SEED-UNCAPTURED')
  })

  it('PASSES (no drift) when renderers were captured and the seed was caught', () => {
    const v = evalTrapDrift({
      trapPresent: true, installed: true, constructedCount: 2, protoRenderIsAccessor: true,
      seedRendererPresent: true, seedRendererCaptured: true,
      seedProtoRenderKind: 'accessor', threeVersion: '0.184.0',
    })
    expect(v.ok).toBe(true)
    expect(v.stop).toBeNull()
  })

  it('PASSES on the WORKBENCH shape -- no seed renderer, but closure-local renderers were captured', () => {
    const v = evalTrapDrift({
      trapPresent: true, installed: true, constructedCount: 2, protoRenderIsAccessor: true,
      seedRendererPresent: false, seedProtoRenderKind: null, threeVersion: '0.184.0',
    })
    expect(v.ok).toBe(true)   // R3 STOPPED here for want of a handle; R4 does not need one
    expect(v.stop).toBeNull()
  })
})

describe('UI-74-R4 R2 BLOCKER 1: first-call observation cross-check (WO item 2)', () => {
  // Each row states its verdict; the BYPASS row is the one the mutation harness
  // requires to redden, and it was GREEN under R2's wrapped===true-alone rule.
  type Row = { what: string; calls: number | null; draws: number | null; ok: boolean }
  const rows: Row[] = [
    { what: 'the real renderer: drew AND was observed rendering', calls: 900, draws: 4200, ok: true },
    { what: 'BYPASS: drew while the census watched but the wrap saw ZERO calls', calls: 0, draws: 120, ok: false },
    { what: 'idle/discarded renderer: drew nothing, observed nothing (vacuously fine)', calls: 0, draws: 0, ok: true },
    { what: 'observed rendering but no draws-since-install measurement available', calls: 5, draws: null, ok: true },
    { what: 'BYPASS by null calls: drew but the wrap recorded no count at all', calls: null, draws: 60, ok: false },
  ]
  for (const r of rows) {
    it(`${r.ok ? 'PASSES' : 'REFUSES'}: ${r.what}`, () => {
      const v = evalRendererFirstCall([{ rid: 'R1', page: 'cam-page', calls: r.calls, drawsSinceInstall: r.draws, where: 'X.ts:1' }])
      expect(v.ok).toBe(r.ok)
      if (!r.ok) expect(v.offenders.length).toBe(1)
    })
  }

  it('names every bypassing surface, not just the first', () => {
    const v = evalRendererFirstCall([
      { rid: 'R1', page: 'cam-page', calls: 10, drawsSinceInstall: 100, where: 'ok.ts:1' },
      { rid: 'R2', page: 'cam-page', calls: 0, drawsSinceInstall: 30, where: 'bypass-a.ts:1' },
      { rid: 'R3', page: 'workbench-page', calls: 0, drawsSinceInstall: 55, where: 'bypass-b.ts:1' },
    ])
    expect(v.ok).toBe(false)
    expect(v.offenders.length).toBe(2)
    expect(v.offenders.join(' ')).toMatch(/bypass-a\.ts:1/)
    expect(v.offenders.join(' ')).toMatch(/bypass-b\.ts:1/)
  })
})
