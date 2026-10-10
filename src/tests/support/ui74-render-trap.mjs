// WO UI-74-R4 -- THE RULED RENDER TRAP, and the two pure predicates that make it
// falsifiable without a browser.
//
// ── THE MECHANISM THE ARCHITECT RULED (DECISIONS 2026-07-17, "UI-74-R4
//    mechanism ruling", quoted binding in the work order) ────────────────────
//
//   "At PAGE BOOTSTRAP, BEFORE ANY APP CODE RUNS ... install an ACCESSOR
//    PROPERTY named `render` on THREE.WebGLRenderer.prototype: the SETTER
//    intercepts the constructor's own-property assignment, stores the real
//    function per-instance (WeakMap), and installs the observing wrap; the getter
//    returns the wrap. Every instance - closure-local and pre-existing renderers
//    included - is captured AT CONSTRUCTION; the FIRST render call is observed by
//    construction. VERSION-DRIFT TRIPWIRE: if the setter never fires for a
//    constructed renderer (three upgraded, render back on the prototype), the
//    census STOPS by name - never silently enumerates nothing."
//
// ── WHY IT WORKS ON three 0.184, AND WHY R1-R3's WALK DID NOT ────────────────
// three 0.184's WebGLRenderer is a class with NO prototype methods: its
// constructor assigns `this.render = function (scene, camera) {...}` as an OWN
// INSTANCE property (three.module.js:17541, inside `class WebGLRenderer {` at
// :16003), and `this.isWebGLRenderer = true` is set FIRST, at :16034. So
// WebGLRenderer.prototype owns only [constructor, coordinateSystem,
// outputColorSpace]. AM1's bound walk (getPrototypeOf(seed) -> own `render`)
// therefore terminated empty and R3 STOPPED by contract -- that fact is proved in
// tools/diag/ui74-r2-am1-probe.mjs FACTS 1-3, unchanged.
//
// The accessor route turns that same fact into the mechanism. A property
// ASSIGNMENT consults the prototype chain for a SETTER: `this.render = fn` with a
// setter reachable on the chain calls the setter instead of creating the own data
// property. So a `render` accessor installed on the renderer's prototype BEFORE
// construction intercepts three's own per-instance assignment, at construction,
// with `this` === the renderer being built. That is exactly FACT 4 of the probe,
// which the R3 audit accepted as VIABLE and the Architect has now ADOPTED.
//
// ── THE ONE WRINKLE: THREE DOES NOT EXIST AT BOOTSTRAP ──────────────────────
// addInitScript runs before any app module evaluates, so THREE.WebGLRenderer --
// and its prototype -- do not exist yet; there is nothing to install the accessor
// ON. The trap reaches WebGLRenderer.prototype the only way available that early:
// it installs the accessor transiently on Object.prototype (the bottom of every
// instance's chain), and the FIRST WebGLRenderer's own `this.render = fn` is
// caught there. At that instant Object.getPrototypeOf(this) IS
// WebGLRenderer.prototype, so the trap MIGRATES the accessor onto it and REMOVES
// the Object.prototype one. From then on the accessor lives exactly where the
// ruling says -- on THREE.WebGLRenderer.prototype -- and every later renderer is
// caught there at its own construction. The Object.prototype phase is a bootstrap
// to reach the prototype, transient by construction, and it is non-enumerable so
// it never appears in a for..in; a `.render =` assignment on a NON-renderer during
// that phase is given a plain own data property, exactly as it would have gotten
// without the trap.
//
// ── FALSIFIABILITY WITHOUT A BROWSER ────────────────────────────────────────
// RENDER_TRAP_INIT references only globalThis, Object, WeakMap and Error, so it
// runs in node against a mock WebGLRenderer class exactly as it runs in the page.
// src/tests/viewport/renderTrap.ui74.test.ts drives it both ways -- the three
// 0.184 shape (per-instance assignment -> captured at construction, first call
// observed) and the DRIFT shape (render on the prototype -> setter never fires ->
// evalTrapDrift STOPS by name) -- so the mechanism and its tripwire are proved to
// can-fail with no GPU. evalRendererFirstCall is R2 BLOCKER 1 as a pure decision
// (a renderer whose GL context DREW while a wrap recorded ZERO render calls was
// bypassed) and evalTrapDrift is the tripwire as a pure decision; both are tabled
// tests, and tools/diag/ui74-r4-trap-mutation.mjs reinjects the old bugs and
// requires the named rows to redden.

// ─────────────────────────────────────────────────────────────────────────────
// RENDER_TRAP_INIT -- injected at page bootstrap via page.addInitScript. MUST be
// fully self-contained: Playwright serializes it with .toString(), so it may not
// close over any outer binding or import. It uses globalThis (=== window in the
// page) so the very same function body also runs under node in the unit test.
export function RENDER_TRAP_INIT() {
  const g = globalThis
  // Re-entrant guard: addInitScript runs on every navigation, and each navigation
  // is a fresh realm with a fresh Object.prototype, so a fresh trap is correct.
  // The guard only protects against a double-install within ONE realm.
  if (g.__ui74Trap && g.__ui74Trap.installedOnObjectProto === true && g.__ui74Trap.migrated !== true) {
    // already armed on Object.prototype this realm, not yet migrated -- leave it.
    return
  }
  const trap = {
    reals: new WeakMap(),     // renderer instance -> the real render fn we intercepted
    wraps: new WeakMap(),     // renderer instance -> the observing wrap the getter returns
    records: new WeakMap(),   // renderer instance -> { rid, calls }
    rendererRefs: [],         // WeakRef(instance) + rid, so HARVEST can iterate without pinning
    cameras: new Map(),       // camera.uuid -> { uuid, type, ref: WeakRef(camera), spied }
    triples: new Map(),       // `${rid}|${sceneId}|${camUuid}` -> distinct (renderer,scene,camera) triple
    writes: [],               // every near/far write, tagged by camera uuid, with its stack
    sceneIds: new WeakMap(),  // scene object -> synthetic id (triple identity without pinning by name)
    nextRid: 1,
    nextSceneId: 1,
    constructedCount: 0,      // how many renderers the SETTER captured at construction
    migrated: false,
    installedOnObjectProto: false,
    protoRenderIsAccessor: false, // set true once our accessor lives on WebGLRenderer.prototype
    firstCaptureStack: null,
    // THE OBSERVATION WINDOW. The wrap exists from construction and COUNTS every
    // call from the first (rec.calls) -- that is BLOCKER 1's mechanism, and check
    // 9 cross-checks it against GL draws SINCE install. But the verdict-bearing
    // enumeration (triples, cameras, near/far writes) only records once the census
    // opens the window at INSTALL_CENSUS, so boot-phase transients -- a
    // StrictMode-discarded renderer's single frame, the workbench's one init
    // perspective frame before the active ortho settles -- are not mistaken for
    // the steady-state view N-36 governs. A persistent clip renders in steady
    // state and is caught; a one-frame boot flash is out of N-36's scope, and this
    // window is disclosed, not a hole.
    observing: false,
  }
  g.__ui74Trap = trap

  const isRenderer = (o) => { try { return o != null && o.isWebGLRenderer === true } catch { return false } }

  const sceneIdOf = (scene) => {
    let id = trap.sceneIds.get(scene)
    if (id === undefined) { id = 'S' + (trap.nextSceneId++); trap.sceneIds.set(scene, id) }
    return id
  }

  // Spy a camera's near/far ONCE. The stack of each write names the file:line that
  // actually wrote the depth (preflight AM3), whatever the code is called.
  const spyCamera = (cam) => {
    const existing = trap.cameras.get(cam.uuid)
    if (existing !== undefined && existing.spied === true) return existing.spied
    let spied = true
    for (const prop of ['near', 'far']) {
      const own = Object.getOwnPropertyDescriptor(cam, prop)
      if (own !== undefined && own.configurable === false) { spied = false; continue }
      let value = cam[prop]
      Object.defineProperty(cam, prop, {
        configurable: true, enumerable: true,
        get() { return value },
        set(next) {
          if (next !== value) trap.writes.push({ camera: cam.uuid, prop, from: value, to: next, stack: new Error().stack })
          value = next
        },
      })
    }
    trap.cameras.set(cam.uuid, { uuid: cam.uuid, type: cam.type, ref: new WeakRef(cam), spied })
    return spied
  }

  // THE OBSERVATION POINT. Runs on EVERY render call, from the FIRST, because the
  // wrap is what `instance.render` has been since construction. Retains DISTINCT
  // (renderer, scene, camera) triples by object identity -- never overwriting a
  // scene, never aggregating by camera uuid alone (R2 BLOCKER 2).
  const observe = (instance, scene, camera, stack) => {
    const rec = trap.records.get(instance)
    // ALWAYS count -- this is what proves the wrap saw the FIRST call (BLOCKER 1),
    // and check 9 measures calls SINCE install against GL draws since install.
    if (rec !== undefined) rec.calls += 1
    // Verdict-bearing enumeration is the STEADY-STATE window only.
    if (trap.observing !== true) return
    if (!(camera && camera.isCamera === true)) return
    if (!(scene && scene.isObject3D === true)) return
    spyCamera(camera)
    const rid = rec ? rec.rid : '(unknown)'
    const sid = sceneIdOf(scene)
    const key = `${rid}|${sid}|${camera.uuid}`
    let t = trap.triples.get(key)
    if (t === undefined) {
      t = {
        rid, sceneId: sid, camUuid: camera.uuid, cameraType: camera.type,
        sceneRef: new WeakRef(scene), cameraRef: new WeakRef(camera),
        passes: 0, renderStacks: [],
      }
      trap.triples.set(key, t)
    }
    t.passes += 1
    if (t.renderStacks.length < 12) t.renderStacks.push(stack) // no six-cap (R2 BLOCKER 2)
  }

  const makeWrap = (instance) => function ui74RenderWrap(scene, camera) {
    // A census must NEVER break the app's render loop. Observation is wrapped in
    // its own try; the real render always runs, on the real receiver.
    try { observe(instance, scene, camera, new Error().stack) } catch { /* never throw into render */ }
    const real = trap.reals.get(instance)
    return real.apply(this, arguments)
  }

  const capture = (instance, fn) => {
    if (trap.reals.has(instance)) return
    trap.reals.set(instance, fn)
    const rec = { rid: 'R' + (trap.nextRid++), calls: 0, callsAtInstall: 0 }
    trap.records.set(instance, rec)
    trap.wraps.set(instance, makeWrap(instance))
    trap.rendererRefs.push({ ref: new WeakRef(instance), rid: rec.rid })
    trap.constructedCount += 1
    if (trap.firstCaptureStack === null) trap.firstCaptureStack = new Error().stack
  }

  // The one accessor descriptor, shared between the Object.prototype bootstrap and
  // the migrated WebGLRenderer.prototype resting place.
  const descriptor = {
    configurable: true,
    enumerable: false,
    get() {
      const wrap = trap.wraps.get(this)
      return wrap !== undefined ? wrap : undefined
    },
    set(fn) {
      if (typeof fn === 'function' && isRenderer(this)) {
        capture(this, fn)
        if (trap.migrated !== true) {
          const proto = Object.getPrototypeOf(this) // === WebGLRenderer.prototype
          Object.defineProperty(proto, 'render', descriptor)
          try { delete Object.prototype.render } catch { /* leave it; it is harmless and non-enumerable */ }
          trap.migrated = true
          trap.protoRenderIsAccessor = true
        }
        return
      }
      // A non-renderer assigned `.render` during the bootstrap window: give it the
      // plain own data property it would have had without the trap. Nothing about
      // that object is disturbed.
      Object.defineProperty(this, 'render', { value: fn, writable: true, enumerable: true, configurable: true })
    },
  }
  Object.defineProperty(Object.prototype, 'render', descriptor)
  trap.installedOnObjectProto = true
}

// ─────────────────────────────────────────────────────────────────────────────
// evalTrapDrift -- THE VERSION-DRIFT TRIPWIRE, as a pure decision. Given the
// signals the page can measure after boot, decide whether the ruled mechanism
// actually installed, or whether three has drifted such that the setter never
// fired -- in which case the census STOPS BY NAME rather than enumerating nothing.
//
// signals:
//   constructedCount        - renderers the SETTER captured at construction
//   protoRenderIsAccessor   - our accessor is the `render` on WebGLRenderer.prototype
//   seedRendererPresent     - window.__cncViewport.renderer exists and isWebGLRenderer
//   seedRendererCaptured    - that seed renderer is in trap.reals (was caught at construction)
//   seedProtoRenderKind     - 'accessor' | 'data-function' | 'none' | null: what
//                             Object.getOwnPropertyDescriptor(getPrototypeOf(seed),'render') is
//   threeVersion            - the pinned three version, for the message
export function evalTrapDrift(signals) {
  const s = signals || {}
  const v = s.threeVersion ? `three ${s.threeVersion}` : 'the pinned three version'

  if (s.installed === false || s.trapPresent === false) {
    return { ok: false, stop: 'STOP-TRAP-ABSENT', why:
      'RENDER_TRAP_INIT did not run at bootstrap: globalThis.__ui74Trap is absent, so no renderer could '
      + 'have been captured at construction. There is no observation mechanism, and this census reports '
      + 'nothing rather than a false clean.' }
  }

  // three moved render back onto the prototype: our per-instance setter can never
  // fire, so the mechanism is void on this version. STOP BY NAME.
  if (s.seedProtoRenderKind === 'data-function') {
    return { ok: false, stop: 'STOP-VERSION-DRIFT', why:
      `VERSION-DRIFT TRIPWIRE FIRED: on ${v} the seed renderer's prototype now carries `
      + '`render` as an OWN DATA FUNCTION (a prototype method), not a per-instance assignment. The ruled '
      + 'accessor trap intercepts the constructor\'s `this.render = fn`; a prototype method is never '
      + 'assigned per instance, so the SETTER NEVER FIRES and no instance is captured. The census STOPS '
      + 'by name instead of silently enumerating nothing -- re-derive the mechanism against the new '
      + 'three before trusting any verdict.' }
  }

  if (s.constructedCount === 0) {
    return { ok: false, stop: 'STOP-NO-CAPTURE', why:
      `VERSION-DRIFT TRIPWIRE FIRED: the render trap captured ZERO renderers at construction on ${v}, `
      + 'yet the page reached its render loop. The setter never fired for any constructed renderer -- '
      + 'either render is no longer a per-instance own assignment, or the trap did not arm before the '
      + 'first construction. Enumerating nothing is not a clean census; this STOPS by name.'
      + (s.seedRendererPresent === true && s.seedRendererCaptured === false
        ? ' (Confirmed on the seed: window.__cncViewport.renderer exists but is NOT in the trap.)' : '') }
  }

  // A seed renderer is exposed but the trap did not catch it -- the trap armed too
  // late, or this renderer came from a second three module the trap never saw.
  if (s.seedRendererPresent === true && s.seedRendererCaptured === false) {
    return { ok: false, stop: 'STOP-SEED-UNCAPTURED', why:
      'the exposed seed renderer (window.__cncViewport.renderer) was NOT captured at construction, though '
      + `${s.constructedCount} other renderer(s) were. A renderer that escaped the trap is a renderer whose `
      + 'cameras this census cannot see -- possibly a second three module instance. STOP by name; do not '
      + 'report a verdict that omits it.' }
  }

  return { ok: true, stop: null, why:
    `render trap installed as ruled on ${v}: ${s.constructedCount} renderer(s) captured at construction`
    + (s.protoRenderIsAccessor ? ', accessor resident on WebGLRenderer.prototype' : '')
    + (s.seedRendererPresent === true ? `, seed renderer captured: ${s.seedRendererCaptured === true}` : ', no seed-renderer handle on this route (closure-local renderers captured by the prototype trap)') + '.' }
}

// ─────────────────────────────────────────────────────────────────────────────
// evalRendererFirstCall -- R2 BLOCKER 1, as a pure decision.
//
// The blocker: R2 installed its wrap from INSIDE an already-active render, so a
// pre-existing renderer's FIRST render call was never observed, yet check 9
// accepted the renderer on wrapped===true ALONE, with calls===0. The R4 trap
// wraps at construction, so the first call IS observed -- and this predicate is
// the load-bearing cross-check that proves it, independently of the wrap: a GL
// context that DREW (its own draw-call counter moved while the census watched)
// whose wrapped renderer recorded ZERO render calls was rendered THROUGH A PATH
// THE WRAP DID NOT SEE. That is the bypass, and it FAILS here by name.
//
// A surface that drew nothing (drawsSinceInstall === 0) is vacuously fine: nothing
// rendered through it to observe. A garbage-collected surface is covered by check
// 9's collected path and is not passed here as live.
//
// surfaces: [{ rid, page, calls, drawsSinceInstall, where }]
//   -- one entry per LIVE (not collected) WebGL surface that maps to a wrapped
//      renderer. calls = the wrap's observed render-call count; drawsSinceInstall
//      = the GL context's own draw-call delta since census install.
export function evalRendererFirstCall(surfaces) {
  const list = Array.isArray(surfaces) ? surfaces : []
  const offenders = []
  for (const s of list) {
    const drew = typeof s.drawsSinceInstall === 'number' && s.drawsSinceInstall > 0
    if (drew && !(typeof s.calls === 'number' && s.calls > 0)) {
      offenders.push(`${s.page ?? '?'}/${s.rid ?? '?'} at ${s.where ?? '(unknown site)'}: GL context drew `
        + `${s.drawsSinceInstall} time(s) while the census watched, but the wrapped renderer observed `
        + `${s.calls} render call(s) -- rendering bypassed the wrap, so its FIRST (and every) camera pass `
        + 'went unseen. A wrapped renderer that draws must be observed rendering.')
    }
  }
  return { ok: offenders.length === 0, offenders }
}
