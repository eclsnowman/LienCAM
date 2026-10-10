// @vitest-environment jsdom
//
// WO UI-78 -- THE DOM ATTACH-GUARD GATE. Enforcement at the attach choke point,
// proven can-fail on real constructs.
//
// This is the verdict-bearing file. Every acceptance criterion (AC1-AC8) and
// every load-bearing preflight amendment (AM1-AM8) is earned here on a live
// jsdom document with the guard installed, by ATTACHING the exact construct and
// asserting the GUARD's own refusal signal fired -- never by invoking the static
// lint walker (that is AM7's whole point). The seven historical bypasses are
// driven through the new execution harness (overlayAttachGuardHarness.ts).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

import {
  installOverlayAttachGuard,
  uninstallOverlayAttachGuard,
  drainGuard,
  getGuardRefusals,
  getReclassifyPassCount,
  getBackstopPassCount,
  resetGuardRefusals,
  setGuardDisabled,
  isGuardDisabled,
  isBackstopDisabled,
  guardIsInstalled,
  isSanctionedFloating,
  SANCTION_MARKER,
  BACKSTOP_PERIOD_MS,
  type AttachGuardOptions,
  type GuardRefusal,
} from './support/overlayAttachGuard'
import { OUT_OF_FLOW, classifyFloating } from './support/overlayFloating'
import { OUT_OF_FLOW as OUT_OF_FLOW_CENSUS } from './support/overlayRuntimeCensus'
import { injectAppStylesheet } from './support/overlayRuntimeCensus'
import { buildKeyMap, dispositionFor } from './support/overlayKeyMap'
import { SANCTIONED_AUTHORING } from './support/overlayAuthoringLint'
import { SEVEN_BYPASSES, attachAndDrain } from './support/overlayAttachGuardHarness'

// The census REFUSES to attribute a JSX node without this recorder (it is what
// stamps data-ui70-site on every host element), and the guard's REGIME-1
// disposition cross-check reads that attribute. vi.mock hoists it above every
// component import. Instrumentation, not a mock: the real jsxDEV runs.
//
// WO-1052 FINDING: not converted to typedMock. wrapJsxDev's signature is
// `<T extends (...args: unknown[]) => unknown>(actual: T) => T` (support/
// overlayRuntimeCensus.ts), so its return here is typed `(...args: unknown[])
// => unknown`, which is not assignable to react/jsx-dev-runtime's real
// `jsxDEV: (...) => ReactElement` (tsc: "Type 'unknown' is not assignable to
// type 'ReactElement'"). Reconciling it needs either a narrowing cast on the
// return value (forbidden by this sweep) or a signature change to wrapJsxDev
// itself, which lives in support/overlayRuntimeCensus.ts - not one of this
// sweep's listed files.
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  const { wrapJsxDev } = await import('./support/overlayRuntimeCensus')
  return { ...actual, jsxDEV: wrapJsxDev(actual.jsxDEV as unknown as (...args: unknown[]) => unknown) }
})

// ---------------------------------------------------------------------------
// REGIME 1 (AM5): the disposition-backed sanctioned-JSX predicate. A JSX node
// (one carrying data-ui70-site) is sanctioned ONLY if its authoring site is
// dispositioned in the census -- so an ordinary product overlay
// (TreeContextMenu's scrim/menu) passes, while a JSX impostor at an
// undispositioned site (the reused-class HUD, the styled wrapper, the body
// portal) is refused. This is the runtime adapter the preflight requires be
// stated, derived from the census's own disposition set, not a hand list.
const keyMap = buildKeyMap()
function sanctionedJsx(el: Element): boolean {
  const site = el.getAttribute('data-ui70-site')
  if (site === null) return false
  const authoringKey = keyMap.bySite.get(site)?.authoringKey
  return authoringKey !== undefined && dispositionFor(authoringKey) !== undefined
}
const GUARD_OPTS: AttachGuardOptions = { isSanctionedJsx: sanctionedJsx }

// The static walk memoises on first call; nothing here invokes it, but keyMap's
// derivation reads source once -- warm it outside any test's 5 s budget.
beforeAll(() => { void keyMap }, 120_000)

let removeStylesheet: (() => void) | null = null
beforeEach(() => {
  // Test isolation: manual appends (attachFixed, iframes, shadow hosts) and
  // document.write content persist across tests -- testing-library's cleanup()
  // only unmounts what IT rendered. Clear the tree BEFORE installing, or the
  // guard's install-time scan correctly refuses last test's leftover HUDs and
  // pollutes this test's refusal log.
  document.head.querySelectorAll('style').forEach((s) => s.remove())
  document.body.replaceChildren()
  removeStylesheet = injectAppStylesheet()
  resetGuardRefusals()
  // NOTE: beforeEach deliberately does NOT force setGuardDisabled(false). The
  // module DEFAULT (false) governs, so the AC4 mutation sentinel below -- the
  // first test in the file -- observes that default before any afterEach reset,
  // and flipping the named UI78_GUARD_DISABLED default to `true` turns exactly
  // that test RED. afterEach restores false for cross-test isolation.
  installOverlayAttachGuard(document, GUARD_OPTS)
})
afterEach(() => {
  if (guardIsInstalled()) uninstallOverlayAttachGuard()
  cleanup()
  removeStylesheet?.()
  removeStylesheet = null
  document.body.replaceChildren()
  document.head.querySelectorAll('style').forEach((s) => s.remove())
  setGuardDisabled(false)
  vi.clearAllMocks()
})

/** Flush React effects + the MutationObserver microtask, then drain the guard's
 *  observers synchronously so the assertion cannot race attach. */
async function settleAndDrain(action: () => void): Promise<readonly GuardRefusal[]> {
  await act(async () => { action(); await new Promise((r) => setTimeout(r, 0)) })
  drainGuard()
  return getGuardRefusals()
}

function attachFixed(className: string, doc: Document = document, marker = false): HTMLElement {
  const el = doc.createElement('div')
  el.className = className
  el.style.position = 'fixed'
  el.style.top = '0'
  el.style.left = '0'
  if (marker) el.setAttribute(SANCTION_MARKER, 'test-owned')
  doc.body.appendChild(el)
  return el
}

// ===========================================================================
// AC4 MUTATION SENTINEL -- FIRST test, keyed to the module default of the named
// toggle. This is the committed test the AC4 mutation proof turns RED: flip
// `let UI78_GUARD_DISABLED = false` to `= true` in overlayAttachGuard.ts and
// THIS test (which never calls setGuardDisabled, so it runs on the module
// default before any afterEach reset) goes RED; restore and it is GREEN again.
// Kept first so the module default -- not a per-test override -- governs it.
// ===========================================================================
describe('AC4 mutation sentinel: the named UI78_GUARD_DISABLED toggle is load-bearing', () => {
  it('SENTINEL: a fixed HUD is refused at attach on the module default (flip the toggle default -> RED)', async () => {
    expect(isGuardDisabled(), 'this test runs on the guard\'s module default').toBe(false)
    const refusals = await settleAndDrain(() => attachFixed('ac4-sentinel-hud'))
    expect(
      refusals.some((r) => r.classes.includes('ac4-sentinel-hud')),
      'with the guard enabled by default the HUD is refused; flipping UI78_GUARD_DISABLED to true turns this RED',
    ).toBe(true)
  })
})

// ===========================================================================
// AC1 -- the sanctioned set derives from source, not a hand list
// ===========================================================================
describe('AC1: the sanctioned set derives from overlayAuthoringLint source', () => {
  it('the source-derived SANCTIONED_AUTHORING set is what governs -- non-empty, and the guard defines no rival list', () => {
    // The guard hardcodes NO list of sanctioned sites; its runtime adapter is
    // the ownership marker + the disposition predicate, both tied to the source
    // the lint already governs. The set itself is SANCTIONED_AUTHORING.
    expect(SANCTIONED_AUTHORING.length).toBeGreaterThan(0)
    // Every sanctioned floating route in source is an in-tree/imperative product
    // site -- NONE of them is one of the adversarial HUD signatures the seven
    // bypasses attach. The bypasses are unsanctioned in source, which is why the
    // guard refuses them below.
    const sanctionedKeys = SANCTIONED_AUTHORING.map((s) => s.key.toLowerCase()).join('\n')
    for (const needle of ['auditor-', 'sketch-prompt-bar', 'sc-ui70-', 'documentwrite-hud']) {
      expect(sanctionedKeys.includes(needle), `no bypass signature "${needle}" may appear in the sanctioned set`).toBe(false)
    }
  })

  it('the ONE classification is shared: the guard reads the SAME OUT_OF_FLOW set the census does', () => {
    // AC1 "reuse ... not a new one": overlayFloating owns OUT_OF_FLOW and the
    // census re-exports it, so this is the identical set object -- not two
    // definitions that could drift.
    expect(OUT_OF_FLOW).toBe(OUT_OF_FLOW_CENSUS)
    expect([...OUT_OF_FLOW].sort()).toEqual(['absolute', 'fixed', 'sticky'])
  })
})

// ===========================================================================
// AC2 -- the observers: document root + attachShadow hook (incl. nested)
// ===========================================================================
describe('AC2: a document-root observer, and an attachShadow hook on every (nested) root', () => {
  it('the document-root observer refuses an unsanctioned fixed surface attached straight to body', async () => {
    const refusals = await settleAndDrain(() => attachFixed('ac2-body-hud'))
    expect(refusals.some((r) => r.classes.includes('ac2-body-hud'))).toBe(true)
  })

  it('the attachShadow hook observes a NEW shadow root, and a NESTED root inside it', async () => {
    const refusals = await settleAndDrain(() => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root1 = host.attachShadow({ mode: 'open' })
      const hud1 = document.createElement('div')
      hud1.className = 'ac2-shadow-hud'
      hud1.style.position = 'fixed'
      root1.appendChild(hud1)
      const innerHost = document.createElement('div')
      root1.appendChild(innerHost)
      const root2 = innerHost.attachShadow({ mode: 'open' })
      const hud2 = document.createElement('div')
      hud2.className = 'ac2-nested-shadow-hud'
      hud2.style.position = 'fixed'
      root2.appendChild(hud2)
    })
    const classes = refusals.flatMap((r) => r.classes)
    expect(classes, 'the open shadow root HUD must be refused').toContain('ac2-shadow-hud')
    expect(classes, 'the HUD in a root INSIDE a root must be refused -- a descend-once fix would miss it').toContain('ac2-nested-shadow-hud')
  })
})

// ===========================================================================
// AC3 -- the seven historical bypasses, each refused AT ATTACH via the harness
// ===========================================================================
describe('AC3: each historical bypass is refused AT ATTACH (executed, not path-fed -- AM7)', () => {
  it('the regression bed carries all seven bypasses, none silently dropped', () => {
    expect(SEVEN_BYPASSES.map((b) => b.id)).toEqual([
      'css-scan-escape', 'styled-wrapper', 'body-portal', 'shadow-dom',
      'same-origin-iframe', 'dynamic-iframe', 'document-write',
    ])
  })

  for (const spec of SEVEN_BYPASSES) {
    it(`REFUSED AT ATTACH: ${spec.id} (${spec.historical})`, async () => {
      const refusals = await settleAndDrain(() => attachAndDrain(spec))
      expect(refusals.length, `the guard must refuse the ${spec.id} construct at attach`).toBeGreaterThan(0)
      // The refusal must name a floating surface (position in OUT_OF_FLOW) or be
      // the cross-origin/uninspectable by-name refusal -- never an empty gesture.
      expect(refusals.some((r) => OUT_OF_FLOW.has(r.position) || r.channel === 'cross-origin-iframe')).toBe(true)
    })
  }

  it('the bypass HUD signatures actually appear in the refusals (the bed is not vacuous)', async () => {
    const seen = new Set<string>()
    for (const spec of SEVEN_BYPASSES) {
      resetGuardRefusals()
      const refusals = await settleAndDrain(() => attachAndDrain(spec))
      for (const r of refusals) for (const c of r.classes) seen.add(c)
      // document.write HUD carries its class; capture the write channel too.
      if (spec.id === 'document-write') {
        expect(refusals.some((r) => r.classes.includes('auditor-documentwrite-hud'))).toBe(true)
      }
      cleanup()
    }
    expect(seen.has('sketch-prompt-bar'), 'CSS-scan-escape HUD').toBe(true)
    expect([...seen].some((c) => c.startsWith('sc-ui70-')), 'styled-wrapper HUD').toBe(true)
    expect(seen.has('auditor-iframe-hud'), 'iframe child-doc HUD').toBe(true)
    expect(seen.has('auditor-shadow-hud'), 'shadow-root HUD').toBe(true)
  })
})

// ===========================================================================
// AC4 -- mutation proof: the named toggle turns a refusal off, both directions
// ===========================================================================
describe('AC4: UI78_GUARD_DISABLED is the load-bearing toggle (mutation proof)', () => {
  it('enabled -> the document.write HUD is refused; disabled -> the same construct is NOT refused', async () => {
    // GREEN half: guard enabled, the construct is refused.
    setGuardDisabled(false)
    resetGuardRefusals()
    const enabled = await settleAndDrain(() => {
      document.write('<div class="ac4-enabled-hud" style="position:fixed">x</div>')
    })
    expect(isGuardDisabled()).toBe(false)
    expect(enabled.some((r) => r.classes.includes('ac4-enabled-hud')), 'guard ENABLED must refuse the HUD').toBe(true)

    // DISABLED half: same construct, flag flipped, NO refusal recorded. This is
    // the in-suite proof that the toggle is what makes the gate a gate.
    setGuardDisabled(true)
    resetGuardRefusals()
    const disabled = await settleAndDrain(() => {
      const el = document.createElement('div')
      el.className = 'ac4-disabled-hud'
      el.style.position = 'fixed'
      document.body.appendChild(el)
    })
    expect(disabled.length, 'guard DISABLED must record NO refusal -- proving the toggle is load-bearing').toBe(0)
    setGuardDisabled(false)
  })
})

// ===========================================================================
// AC5 -- catch-by-construction on a NOVEL route named by no rule (AM8)
// ===========================================================================
describe('AC5: a genuinely novel attach path is caught by attach-time reasoning, not a rule naming it', () => {
  it('createContextualFragment + insertBefore -- a route in no fixture and no ATTACH_METHODS list', async () => {
    const refusals = await settleAndDrain(() => {
      const frag = document.createRange().createContextualFragment(
        '<div class="auditor-novel-fragment-hud" style="position:fixed;top:0;left:0">novel</div>',
      )
      // insertBefore(null) == append, but through a method NO rule enumerates.
      document.body.insertBefore(frag, null)
    })
    expect(refusals.some((r) => r.classes.includes('auditor-novel-fragment-hud'))).toBe(true)
  })

  it('template.content + replaceChildren -- a second novel route, same catch-by-construction', async () => {
    const refusals = await settleAndDrain(() => {
      const host = document.createElement('section')
      document.body.appendChild(host)
      const tpl = document.createElement('template')
      tpl.innerHTML = '<div class="auditor-novel-template-hud" style="position:fixed">novel2</div>'
      host.replaceChildren(tpl.content.cloneNode(true))
    })
    expect(refusals.some((r) => r.classes.includes('auditor-novel-template-hud'))).toBe(true)
  })
})

// ===========================================================================
// AM1 -- document.open/write survival: the root observer stays live
// ===========================================================================
describe('AM1: the root observer targets the Document node and survives document.write', () => {
  it('after a document.write that replaces the tree, a later fixed surface is STILL caught', async () => {
    const refusals = await settleAndDrain(() => {
      // Replace the whole document body -- documentElement/body are discarded,
      // but the Document node (the observer's target) is not.
      document.write('<div class="am1-written-hud" style="position:fixed">written</div>')
      // A body-append AFTER the write: only a still-live root observer sees it.
      const later = document.createElement('div')
      later.className = 'am1-later-hud'
      later.style.position = 'fixed'
      document.body.appendChild(later)
    })
    const classes = refusals.flatMap((r) => r.classes)
    expect(classes, 'the written HUD is caught').toContain('am1-written-hud')
    expect(classes, 'a surface attached AFTER the write is still caught -- the observer survived').toContain('am1-later-hud')
  })
})

// ===========================================================================
// AM2 -- cross-origin iframe refused BY NAME; same-origin recursed into
// ===========================================================================
describe('AM2: an uninspectable (cross-origin) iframe is refused BY NAME', () => {
  it('an iframe whose contentDocument reads null is refused, not silently passed', async () => {
    const refusals = await settleAndDrain(() => {
      const frame = document.createElement('iframe')
      frame.className = 'am2-cross-origin'
      // Simulate the same-origin policy: contentDocument is null for a
      // cross-origin frame. jsdom has no true cross-origin frame, so we make the
      // property null to reproduce the exact inspectability condition.
      Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => null })
      document.body.appendChild(frame)
    })
    expect(refusals.some((r) => r.channel === 'cross-origin-iframe' && r.classes.includes('am2-cross-origin'))).toBe(true)
  })
})

// ===========================================================================
// AM3 -- an IN-FLOW iframe still gets a child observer (the R5B shape)
// ===========================================================================
describe('AM3: an in-flow, viewport-sized iframe is not itself floating, but its child HUD is caught', () => {
  it('the iframe (position:static) is NOT refused, but a fixed HUD in its contentDocument IS', async () => {
    let frameEl: HTMLIFrameElement | null = null
    const refusals = await settleAndDrain(() => {
      const frame = document.createElement('iframe')
      frame.className = 'am3-inflow-frame'
      frame.style.width = '100%'
      frame.style.height = '100%'
      // position:static -- explicitly in flow, the exact founding-finding shape.
      frame.style.position = 'static'
      document.body.appendChild(frame)
      frameEl = frame
      const childDoc = frame.contentDocument!
      const hud = childDoc.createElement('div')
      hud.className = 'am3-child-hud'
      hud.style.position = 'fixed'
      childDoc.body.appendChild(hud)
    })
    expect(frameEl).not.toBeNull()
    expect(refusals.some((r) => r.classes.includes('am3-inflow-frame')), 'the in-flow iframe itself must NOT be refused').toBe(false)
    expect(refusals.some((r) => r.classes.includes('am3-child-hud') && r.channel === 'iframe-document'), 'its child HUD must be refused').toBe(true)
  })
})

// ===========================================================================
// AM4 -- attribute + stylesheet reclassification of an ALREADY-attached node.
// RE-BOUND (DECISIONS 2026-07-17): reclassification triggers on ANY mutation
// through the single 'reclassify' channel (no 'attributes'/'stylesheet' split);
// the AM4-R block below adds the tenth-bypass, childList-leg and debounce cases.
// ===========================================================================
describe('AM4: a later style/class change or new stylesheet reclassifies an attached node', () => {
  it('an in-flow node that LATER gets position:fixed via a style mutation is refused', async () => {
    const el = document.createElement('div')
    el.className = 'am4-attr-target'
    document.body.appendChild(el)
    // First drain: in-flow, no refusal.
    await settleAndDrain(() => {})
    expect(getGuardRefusals().some((r) => r.classes.includes('am4-attr-target'))).toBe(false)
    // Mutate style on the already-attached node -> an (unfiltered) attributes
    // record fires -> the single debounced reclassify pass refuses it.
    const refusals = await settleAndDrain(() => { el.style.position = 'fixed' })
    expect(refusals.some((r) => r.classes.includes('am4-attr-target') && r.channel === 'reclassify')).toBe(true)
  })

  it('a NEW <style> element that positions an existing class fixed reclassifies it', async () => {
    const el = document.createElement('div')
    el.className = 'am4-css-target'
    document.body.appendChild(el)
    await settleAndDrain(() => {})
    expect(getGuardRefusals().some((r) => r.classes.includes('am4-css-target'))).toBe(false)
    const refusals = await settleAndDrain(() => {
      const style = document.createElement('style')
      style.textContent = '.am4-css-target { position: fixed; top: 0; left: 0; }'
      document.head.appendChild(style)
    })
    expect(refusals.some((r) => r.classes.includes('am4-css-target') && r.channel === 'reclassify')).toBe(true)
  })
})

// ===========================================================================
// AM4-R (DECISIONS 2026-07-17 "AM4 re-bound -- reclassification triggers on ANY
// mutation (tenth bypass)"). The reclassification path no longer enumerates its
// triggers: the observer watches attributes WITHOUT a filter, childList+subtree,
// and characterData, and EVERY record schedules one debounced reclassifyAll.
// These three cases are the auditor's tenth bypass (R2), the childList leg (R3),
// and debounce correctness (R4). Can-fail: narrowing the observer back to
// attributeFilter ['style','class'] turns R2 and R3 RED (the R8 mutation proof).
// ===========================================================================
describe('AM4-R: reclassification triggers on ANY mutation, not an enumerated set', () => {
  it('R2 (tenth bypass): a pre-existing [data-*] rule + in-flow attach + attribute flip -> REFUSED', async () => {
    // The auditor's exact shape. A stylesheet rule keyed on a NON style/class
    // attribute exists FIRST; the node attaches in-flow (must NOT be refused);
    // then a flip of that attribute -- outside any ['style','class'] filter --
    // makes it position:fixed. The narrowed observer saw no record here; the
    // re-bound (unfiltered) observer does, and the reclassify pass refuses it.
    const style = document.createElement('style')
    style.textContent = '[data-floaty] { position: fixed; top: 0; left: 0; }'
    document.head.appendChild(style)

    const el = document.createElement('div')
    el.className = 'r2-tenth-bypass'
    document.body.appendChild(el)
    // Attach drain: the div is in-flow (no data-floaty yet) -> NOT refused.
    await settleAndDrain(() => {})
    expect(
      getGuardRefusals().some((r) => r.classes.includes('r2-tenth-bypass')),
      'the in-flow attach must NOT be refused -- the bypass depends on it slipping in',
    ).toBe(false)

    // The flip: a data-* attribute, invisible to a ['style','class'] filter.
    const refusals = await settleAndDrain(() => { el.setAttribute('data-floaty', '1') })
    expect(
      refusals.some((r) => r.classes.includes('r2-tenth-bypass') && r.channel === 'reclassify'),
      'the now-fixed surface must be refused; with attributeFilter [style,class] restored this goes RED',
    ).toBe(true)
  })

  it('R3 (childList leg): a sibling insertion flips an existing node via a sibling-position rule -> REFUSED', async () => {
    // The pre-existing rule keys on SIBLING POSITION. jsdom's nwsapi caches a
    // :nth-child ordinal on a warmed node and never invalidates it on a sibling
    // insertion (verified: an nth-child flip is jsdom-unexercisable on an
    // already-examined node), but it DOES reflect the sibling combinators + / ~
    // -- the identical childList->reclassify->existing-node-flip leg. So a
    // general-sibling rule drives the case: an already-attached, already-examined
    // in-flow node flips to fixed with NO attribute change ON IT, purely because
    // a sibling was inserted. The mutation record is a bare childList add of a
    // DIFFERENT node; only a reclassifyAll (not a target-scoped re-examination
    // of the added node) catches the node that actually flipped.
    const style = document.createElement('style')
    style.textContent = '.stack > .r3-trigger ~ .r3-target { position: fixed; top: 0; left: 0; }'
    document.head.appendChild(style)

    const stack = document.createElement('div')
    stack.className = 'stack'
    document.body.appendChild(stack)
    const target = document.createElement('div')
    target.className = 'r3-target'
    stack.appendChild(target)
    // Attach drain: target is in-flow (no preceding .r3-trigger) and examined
    // (its computed position is warmed to static) -> NOT refused.
    await settleAndDrain(() => {})
    expect(
      getGuardRefusals().some((r) => r.classes.includes('r3-target')),
      'the pre-existing in-flow node must not be refused before the sibling exists',
    ).toBe(false)

    // Insert the trigger sibling BEFORE the target. The target's attributes never
    // change; the childList record names only the inserted trigger.
    const refusals = await settleAndDrain(() => {
      const trigger = document.createElement('div')
      trigger.className = 'r3-trigger'
      stack.insertBefore(trigger, target)
    })
    expect(
      refusals.some((r) => r.classes.includes('r3-trigger')),
      'the inserted trigger is itself in-flow and must NOT be refused',
    ).toBe(false)
    expect(
      refusals.some((r) => r.classes.includes('r3-target') && r.channel === 'reclassify'),
      'the EXISTING node flipped by the sibling insertion must be refused via the childList->reclassify leg',
    ).toBe(true)
  })

  it('R4 (debounce): N rapid mutations coalesce to exactly ONE reclassify pass, and the flipped node is still refused', () => {
    // Constructed interleave, NOT event-loop reasoning (charter 4): everything is
    // synchronous and the pass is forced by drainGuard, so the pass count is
    // deterministic. A pre-existing [data-*] rule; an in-flow node attached; then
    // N rapid attribute mutations culminating in the flip -- all in one burst,
    // one synchronous drain.
    const style = document.createElement('style')
    style.textContent = '[data-r4-fixed] { position: fixed; top: 0; left: 0; }'
    document.head.appendChild(style)
    const el = document.createElement('div')
    el.className = 'r4-debounce-target'
    document.body.appendChild(el)
    drainGuard() // settle the attach; el is in-flow, not refused
    expect(getGuardRefusals().some((r) => r.classes.includes('r4-debounce-target'))).toBe(false)

    const passesBefore = getReclassifyPassCount()
    const backstopBefore = getBackstopPassCount()
    // N rapid mutations in a single synchronous burst: N-1 no-op attribute writes
    // then the flipping one. All land in one observer batch.
    for (let i = 0; i < 8; i++) el.setAttribute('data-noise', String(i))
    el.setAttribute('data-r4-fixed', '1')
    drainGuard() // ONE forced pass drains the whole batch

    const passesAfter = getReclassifyPassCount()
    expect(
      passesAfter - passesBefore,
      'the debounce must coalesce the whole burst into exactly ONE reclassify pass (no lost-wake, no per-record storm)',
    ).toBe(1)
    // B5: the backstop must NOT pollute the R4 debounce economics. It uses a
    // SEPARATE counter and is a setInterval that cannot fire inside a synchronous,
    // no-await burst (no timer is advanced here), so its delta is exactly 0 and the
    // fast-path pass count above measures only the debounced reclassify.
    expect(
      getBackstopPassCount() - backstopBefore,
      'the backstop does not fire during a synchronous burst -- it is excluded from the R4 measurement (B5)',
    ).toBe(0)
    expect(
      getGuardRefusals().some((r) => r.classes.includes('r4-debounce-target') && r.channel === 'reclassify'),
      'the flipped node must still be refused after the single coalesced pass',
    ).toBe(true)
  })
})

// ===========================================================================
// B-BACKSTOP (DECISIONS 2026-07-17 "UI-78 eleventh bypass: END THE ENUMERATION
// GAME"). The observer + CSSStyleSheet/adoptedStyleSheets hooks + media listener
// are the IMMEDIATE fast path, but the CSSOM hook set is a closed method-name list
// (insertRule/replace/replaceSync) that the eleventh bypass walked via the
// un-hooked deleteRule. The NON-ENUMERATED BACKSTOP -- a dev-only setInterval that
// runs the SAME reclassifyAll with no trigger inspection -- is the floor that
// catches ANY computed-position flip within one BACKSTOP_PERIOD_MS by
// construction. These proofs use FAKE timers so the periodic pass is advanced
// deterministically (charter 4: constructed interleave, not event-loop prose).
// Can-fail: flip `let UI78_BACKSTOP_DISABLED = false` to `= true` (B6) -> B2/B3
// (and B1/B5) go RED while every fast-path fixture (R2-R4) stays GREEN.
// ===========================================================================
describe('B-BACKSTOP: the non-enumerated periodic floor closes the CSSOM leg (eleventh bypass)', () => {
  // The global beforeEach installed the guard under REAL timers; backstop proofs
  // need deterministic timer control, so drop that guard, switch to fake timers,
  // and reinstall -- installBackstop's setInterval is then advanceable.
  beforeEach(() => {
    if (guardIsInstalled()) uninstallOverlayAttachGuard()
    vi.useFakeTimers()
    installOverlayAttachGuard(document, GUARD_OPTS)
    resetGuardRefusals()
  })
  afterEach(() => {
    if (guardIsInstalled()) uninstallOverlayAttachGuard()
    vi.useRealTimers()
  })

  /** Attach a <style> whose first rule sets .cls fixed and whose LATER rule sets
   *  it static (later wins -> in-flow), plus an in-flow div.cls. Return the sheet
   *  so the caller can unmask via an un-hooked deletion. This is the auditor's
   *  exact eleventh-bypass shape. */
  function attachMaskedFixed(cls: string): CSSStyleSheet {
    const style = document.createElement('style')
    style.textContent = `.${cls} { position: fixed; top: 0; left: 0; }\n.${cls} { position: static; }`
    document.head.appendChild(style)
    const el = document.createElement('div')
    el.className = cls
    document.body.appendChild(el)
    return style.sheet as CSSStyleSheet
  }

  it('B2 (eleventh bypass): a deleteRule unmask -- no hook, no mutation record -- is REFUSED within one backstop period', () => {
    expect(isBackstopDisabled(), 'this test runs on the backstop lever\'s module default (flip it -> RED)').toBe(false)
    const sheet = attachMaskedFixed('eleven')
    drainGuard() // attach settle: masked static, in-flow -> NOT refused (the bypass depends on it slipping in)
    expect(getGuardRefusals().some((r) => r.classes.includes('eleven')), 'the masked in-flow attach must NOT be refused').toBe(false)

    // The auditor's exact eleventh-bypass move: deleteRule(1) removes the masking
    // static rule so .eleven computes fixed. deleteRule is NOT hooked and emits NO
    // MutationObserver record, so NO observer/hook fast path can see it.
    sheet.deleteRule(1)
    drainGuard() // prove the fast paths are blind: nothing catches it yet
    expect(getGuardRefusals().some((r) => r.classes.includes('eleven')), 'no observer/hook fast path catches the deleteRule unmask').toBe(false)

    // Just under one period -> still not caught (the latency bound is real, not zero).
    vi.advanceTimersByTime(BACKSTOP_PERIOD_MS - 1)
    expect(getGuardRefusals().some((r) => r.classes.includes('eleven')), 'not yet -- one backstop period has not elapsed').toBe(false)

    // Cross one full period -> the periodic floor refuses it, tagged 'backstop'.
    vi.advanceTimersByTime(1)
    expect(
      getGuardRefusals().some((r) => r.classes.includes('eleven') && r.channel === 'backstop'),
      'within one backstop period the unmasked fixed surface is refused via the periodic floor; disable the backstop -> RED',
    ).toBe(true)
  })

  it('B3 (a DIFFERENT un-hooked CSSOM method): a removeRule unmask is likewise caught by the backstop', () => {
    // Second EXECUTED backstop leg through a distinct un-hooked method. jsdom
    // reflects deleteRule AND its legacy alias removeRule (verified this session);
    // it does NOT reflect the genuinely rule-LEVEL routes (CSSStyleDeclaration.
    // setProperty / rule.style.position / CSSStyleRule.selectorText all leave
    // getComputedStyle static -- verified), so those are named in the guard header
    // as real-browser-covered by the same backstop. removeRule is a distinct
    // CSSStyleSheet method NOT in the hook set ['insertRule','replace','replaceSync'].
    expect(isBackstopDisabled()).toBe(false)
    const sheet = attachMaskedFixed('twelve')
    drainGuard()
    expect(getGuardRefusals().some((r) => r.classes.includes('twelve'))).toBe(false)

    ;(sheet as CSSStyleSheet & { removeRule: (i: number) => void }).removeRule(1)
    drainGuard()
    expect(getGuardRefusals().some((r) => r.classes.includes('twelve')), 'removeRule is also un-hooked -- no fast path catches it').toBe(false)

    vi.advanceTimersByTime(BACKSTOP_PERIOD_MS)
    expect(
      getGuardRefusals().some((r) => r.classes.includes('twelve') && r.channel === 'backstop'),
      'the backstop catches a SECOND distinct un-hooked CSSOM method too; disable the backstop -> RED',
    ).toBe(true)
  })

  it('B5 (quiet page): backstop passes accrue at exactly one per period -- no busy loop -- and a clean in-flow tree stays refusal-free', () => {
    // The guard is freshly installed on an empty body -- a genuinely quiet page.
    const before = getBackstopPassCount()
    vi.advanceTimersByTime(BACKSTOP_PERIOD_MS * 4)
    expect(
      getBackstopPassCount() - before,
      'exactly one backstop pass per period across four periods -- a setInterval floor, never a rAF-style busy loop',
    ).toBe(4)
    expect(getGuardRefusals().length, 'a quiet in-flow page yields no refusals from the periodic passes').toBe(0)
  })

  it('B1 (cleanup tail): uninstall clears the backstop interval -- no timer leaks past uninstall', () => {
    // While installed, the backstop is the sole pending fake timer and it ticks.
    expect(vi.getTimerCount(), 'the backstop interval is pending while installed').toBeGreaterThan(0)
    const before = getBackstopPassCount()
    vi.advanceTimersByTime(BACKSTOP_PERIOD_MS)
    expect(getBackstopPassCount() - before, 'the backstop ticks while installed').toBe(1)

    uninstallOverlayAttachGuard()
    expect(
      vi.getTimerCount(),
      'uninstall cleared the interval -- drop clearInterval from the cleanup tail and this stays > 0 (RED)',
    ).toBe(0)
    const afterUninstall = getBackstopPassCount()
    vi.advanceTimersByTime(BACKSTOP_PERIOD_MS * 5)
    expect(getBackstopPassCount() - afterUninstall, 'no backstop pass fires after uninstall -- the cleanup tail tore it down').toBe(0)
  })
})

// ===========================================================================
// AM5 -- the two sanction regimes, each can-fail
// ===========================================================================
describe('AM5: the sanction adapter -- regime 1 (JSX disposition) and regime 2 (ownership marker)', () => {
  it('REGIME 2 can-fail: a fixed surface WITH the ownership marker passes; the SAME surface WITHOUT it is refused', async () => {
    const owned = await settleAndDrain(() => attachFixed('am5-owned', document, true))
    expect(owned.some((r) => r.classes.includes('am5-owned')), 'a marked surface must NOT be refused').toBe(false)

    resetGuardRefusals()
    const unowned = await settleAndDrain(() => attachFixed('am5-unowned', document, false))
    expect(unowned.some((r) => r.classes.includes('am5-unowned')), 'delete the marker -> the guard refuses it').toBe(true)
  })

  it('REGIME 1: a DISPOSITIONED product overlay (TreeContextMenu) passes; an UNDISPOSITIONED JSX impostor is refused', async () => {
    const { TreeContextMenu } = await import('../../components/panels/TreeContextMenu')
    const refusals = await settleAndDrain(() => {
      render(
        <TreeContextMenu
          at={{ x: 10, y: 10 }}
          target={{ kind: 'setup', setupId: 'guard-setup' }}
          onAction={() => {}}
          onClose={() => {}}
        />,
      )
    })
    // The scrim/menu are dispositioned -> sanctioned by regime 1 -> not refused.
    expect(refusals.some((r) => r.classes.includes('sketch-context-overlay')), 'dispositioned scrim must pass').toBe(false)
    expect(refusals.some((r) => r.classes.includes('sketch-context-menu')), 'dispositioned menu must pass').toBe(false)
    // The reused-class impostor (a JSX .sketch-prompt-bar at an UNdispositioned
    // site) is refused even though it carries a data-ui70-site, because the site
    // is not dispositioned. Proven in the css-scan-escape bypass above; assert
    // the predicate directly here for the seam.
    const impostor = document.createElement('div')
    impostor.className = 'sketch-prompt-bar'
    impostor.setAttribute('data-ui70-site', 'src/tests/ui/fixtures/overlayRuntimeBypass.fixture.tsx@999:1')
    impostor.style.position = 'absolute'
    expect(isSanctionedFloating(impostor, GUARD_OPTS), 'an undispositioned JSX site is NOT sanctioned').toBe(false)
  })
})

// ===========================================================================
// AM6 -- Vite's error overlay is a NAMED exemption (not an incidental pass)
// ===========================================================================
describe('AM6: <vite-error-overlay> is a named exemption; a look-alike is not', () => {
  it('a fixed HUD inside <vite-error-overlay> is exempt; the identical HUD in a normal element is refused', async () => {
    const exempt = await settleAndDrain(() => {
      const overlay = document.createElement('vite-error-overlay')
      const hud = document.createElement('div')
      hud.className = 'vite-overlay-inner'
      hud.style.position = 'fixed'
      overlay.appendChild(hud)
      document.body.appendChild(overlay)
    })
    expect(exempt.some((r) => r.classes.includes('vite-overlay-inner')), 'Vite error overlay content is exempt').toBe(false)

    resetGuardRefusals()
    const control = await settleAndDrain(() => {
      const lookalike = document.createElement('div') // NOT the named custom element
      const hud = document.createElement('div')
      hud.className = 'not-vite-overlay-inner'
      hud.style.position = 'fixed'
      lookalike.appendChild(hud)
      document.body.appendChild(lookalike)
    })
    expect(control.some((r) => r.classes.includes('not-vite-overlay-inner')), 'a look-alike is NOT exempt').toBe(true)
  })
})

// ===========================================================================
// The non-vacuity control in the OTHER direction: the guard does not refuse
// legitimate, sanctioned surfaces, and a clean in-flow tree yields nothing.
// ===========================================================================
describe('non-vacuity: the guard passes sanctioned and in-flow DOM', () => {
  it('a clean in-flow subtree produces no refusal', async () => {
    const refusals = await settleAndDrain(() => {
      const wrap = document.createElement('div')
      wrap.innerHTML = '<header>h</header><main><p>ordinary in-flow content</p></main>'
      document.body.appendChild(wrap)
    })
    expect(refusals.length).toBe(0)
  })

  it('classifyFloating agrees with the census rule on shared cases (no drift between runtimes)', () => {
    const doc = document
    const abs = doc.createElement('div'); abs.style.position = 'absolute'; doc.body.appendChild(abs)
    const stat = doc.createElement('div'); doc.body.appendChild(stat)
    expect(classifyFloating(abs, window).floating).toBe(true)
    expect(classifyFloating(stat, window).floating).toBe(false)
  })
})
