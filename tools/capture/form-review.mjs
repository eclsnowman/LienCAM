// WO-2490: every Form rail tool, walked as a new user would - the real app, the real rail buttons, the real
// viewport clicks. For each tool: (A) click it with nothing selected, (B) make the selection Help asks for with
// viewport clicks and use it. Each step records a frame (or a strip of frames for the click-mode tools), the Form
// palette's status line, whether that line is on screen, browser console lines, the Model console's new lines and
// a measured change (cage point/face/crease counts, the selection, the farthest point move).
//
// Output (the phase's own frames are deleted first): src/tests/evidence/WO-2490/frames/<phase>-*.jpg,
// results-<phase>.json, run-log-<phase>.txt. The findings page is built from them by src/tests/evidence/WO-2490/build-findings.mjs.
//
// Usage, from the repo root, foreground:
//   node tools/capture/form-review.mjs <phase> [port] [--headless]
// phase: start | topo | selopen | symdisp | half | sketches | body | layout (one at a time: each fits a worker's time cap)
// Headed by default (WO-2490 asks for a visible browser); --headless for a box with no desktop.
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withViteCaptureServer } from './lib/provenance.mjs'
import { dismissMachineModal } from './shoot.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const OUT = path.join(REPO_ROOT, 'src/tests/evidence/WO-2490')
const FRAMES = path.join(OUT, 'frames')
const args = process.argv.slice(2)
const PORT = Number(args.find((a) => /^\d+$/.test(a)) ?? 4790)
const HEADLESS = args.includes('--headless')
const PHASE = args.find((a) => /^[a-z]+$/.test(a) && a !== '--headless') ?? 'start'
const VIEWPORT = { width: 1600, height: 900 }
const LAUNCH_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

mkdirSync(FRAMES, { recursive: true })
// delete-first: this phase's own frames (each phase writes its own, so phases run one at a time under a time cap)
for (const f of readdirSync(FRAMES)) if (f.startsWith(`${PHASE}-`)) rmSync(path.join(FRAMES, f))

const results = []
const runLog = []
const log = (line) => { console.log(line); runLog.push(line) }

// ---------- page probes ----------

const state = (page) => page.evaluate(() => {
  const s = window.__formStore?.getState()
  if (!s) return null
  return {
    active: s.active, points: s.cage.positions.length, faces: s.cage.faces.length, creases: s.cage.creases.length,
    selection: { points: s.selection.points.length, edges: s.selection.edges.length, faces: s.selection.faces.length },
    notice: s.notice, symmetry: s.symmetry, circularCopies: s.circularCopies, transformMode: s.transformMode,
    displayMode: s.displayMode, faceTool: s.faceTool === null ? null : { replace: s.faceTool.replace, chain: s.faceTool.chain, clicks: s.faceTool.clicks.length },
    startedFrom: s.startedFrom, undo: s.history.past.length, redo: s.history.future.length,
  }
})
const positions = (page) => page.evaluate(() => window.__formStore.getState().cage.positions.map((p) => [...p]))

/** Is the status line (form-notice) on screen: inside the window and inside the palette's scrolled area, not folded away. */
const noticeOnScreen = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid="form-notice"]')
  if (el === null) return { shown: false, why: 'no status line' }
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return { shown: false, why: 'palette folded (zero size)' }
  if (r.top >= window.innerHeight || r.bottom <= 0) return { shown: false, why: `below the window (top ${Math.round(r.top)} px of ${window.innerHeight})` }
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (/(auto|scroll|hidden)/.test(cs.overflowY)) {
      const c = p.getBoundingClientRect()
      if (r.top >= c.bottom - 4) return { shown: false, why: `scrolled out of the palette (${Math.round(r.top - c.bottom)} px below its visible bottom)` }
      if (r.bottom <= c.top + 4) return { shown: false, why: 'scrolled above the palette' }
    }
  }
  return { shown: true, why: `at y ${Math.round(r.top)} px` }
})

/** The Model console's latest line, as its strip at the foot of the screen shows it. */
const appConsole = (page) => page.evaluate(() => ([...document.querySelectorAll('[data-testid="console-strip"] .console-strip-text')].find((e) => e.offsetParent !== null)?.textContent ?? '').trim())

/** Rail button facts: present, on screen (not cut off by the window), lit. */
const railButton = (page, testId) => page.evaluate((id) => {
  const el = document.querySelector(`[data-testid="${id}"]`)
  if (el === null) return { present: false }
  const r = el.getBoundingClientRect()
  return { present: true, onScreen: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0, lit: el.getAttribute('aria-pressed') === 'true', title: el.getAttribute('title') ?? el.getAttribute('data-tooltip') ?? null, y: Math.round(r.top) }
}, testId)

/**
 * Screen spots where a click picks exactly that cage element (the overlay's own picker says so), page pixels.
 * kind: 'point' | 'edge' | 'face'.
 */
const pickable = (page, kind) => page.evaluate((k) => {
  const canvas = document.querySelector('[data-testid="solids-workbench-canvas"]')
  const r = canvas.getBoundingClientRect()
  const ov = window.__formOverlay
  const s = window.__formStore.getState()
  const P = s.cage.positions
  const out = []
  const tryAt = (world, match) => {
    const q = ov.screenOf(world)
    if (!(q.x > 8 && q.y > 8 && q.x < r.width - 8 && q.y < r.height - 8)) return
    const hit = ov.pickAt(q.x, q.y)
    if (hit !== null && match(hit)) out.push({ x: r.left + q.x, y: r.top + q.y, world })
  }
  if (k === 'point') P.forEach((p, i) => {
    const n = out.length
    tryAt(p, (h) => h.kind === 'point' && h.index === i)
    if (out.length > n) out[n].index = i
  })
  if (k === 'edge') {
    const seen = new Set()
    for (const f of s.cage.faces) for (let j = 0; j < f.length; j++) {
      const a = f[j], b = f[(j + 1) % f.length], key = a < b ? `${a}:${b}` : `${b}:${a}`
      if (seen.has(key)) continue
      seen.add(key)
      const n = out.length
      tryAt([0, 1, 2].map((c) => (P[a][c] + P[b][c]) / 2), (h) => h.kind === 'edge' && h.key === key)
      if (out.length > n) Object.assign(out[n], { key, a: P[a], b: P[b] })
    }
  }
  if (k === 'face') s.cage.faces.forEach((f, i) => {
    const n = out.length
    tryAt([0, 1, 2].map((c) => f.reduce((acc, v) => acc + P[v][c], 0) / f.length), (h) => h.kind === 'face' && h.index === i)
    if (out.length > n) Object.assign(out[n], { index: i, verts: [...f] })
  })
  return out
}, kind)

// ---------- user actions (real input) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function click(page, at, { shift = false } = {}) {
  const box = await page.evaluate(() => { const r = document.querySelector('[data-testid="solids-workbench-canvas"]').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } })
  if (!(at.x > box.l + 4 && at.x < box.r - 4 && at.y > box.t + 4 && at.y < box.b - 4)) throw new Error(`click at ${Math.round(at.x)},${Math.round(at.y)} is outside the view - refused (it would land on the panels)`)
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.click(at.x, at.y)
  if (shift) await page.keyboard.up('Shift')
  await sleep(250)
}
async function rail(page, testId) {
  await page.click(`[data-testid="${testId}"]`)
  await sleep(450)
}
async function clearSelection(page) {
  await page.keyboard.press('Escape')
  await sleep(150)
}

async function openForm(page) {
  if ((await page.evaluate(() => window.__formStore?.getState().active === true))) {
    await page.click('[data-testid="form-cancel"]')
    await page.waitForFunction(() => window.__formStore.getState().active === false, null, { timeout: 30_000 })
  }
  await page.click('[data-testid="workbench-form"]')
  await page.waitForFunction(() => window.__formStore?.getState().active === true && window.__formOverlay != null, null, { timeout: 30_000 })
  await sleep(600)
}
/** A fresh form (Cancel, Form again) on a starter shape; the starter button clicked when the form is not that shape yet. */
async function fresh(page, starter = 'box') {
  // the Model console folded, as a new user finds it (layoutFacts measures it open)
  if (await page.evaluate(() => [...document.querySelectorAll('[data-testid="console-strip"]')].some((e) => e.offsetParent !== null && e.getAttribute('aria-expanded') === 'true'))) await page.click('[data-testid="console-strip"] >> visible=true')
  await openForm(page)
  const s = await state(page)
  if (s.startedFrom !== starter) await rail(page, `form-starter-${starter}`)
  await page.mouse.move(VIEWPORT.width - 10, VIEWPORT.height - 10)
  await sleep(300)
}

let frameNo = 0
async function frame(page, tool, step) {
  await page.mouse.move(VIEWPORT.width - 10, VIEWPORT.height - 10)
  await sleep(350)
  const name = `${PHASE}-${String(++frameNo).padStart(3, '0')}-${tool.replace(/^form-/, '')}-${step}.jpg`
  await page.screenshot({ path: path.join(FRAMES, name), type: 'jpeg', quality: 62 })
  return `frames/${name}`
}

function farthestMove(before, after) {
  if (before.length !== after.length) return null
  let far = 0
  for (let i = 0; i < before.length; i++) far = Math.max(far, Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1], after[i][2] - before[i][2]))
  return +far.toFixed(3)
}

/**
 * One recorded use of a tool: `act` does the clicks. Records the state before/after, the status line, whether
 * it is on screen, console lines during the step, frames.
 */
async function step(ctx, tool, stepName, { prep, act, strip = false }) {
  const { page } = ctx
  const consoleStart = ctx.consoleLines.length
  const appBefore = await appConsole(page)
  if (prep) await prep()
  const before = await state(page)
  const posBefore = await positions(page)
  const frames = []
  if (stepName !== 'nothing-selected') frames.push(await frame(page, tool, `${stepName}-before`))
  const strips = [], stripNotices = []
  await act({ snap: async (label) => { strips.push(await frame(page, tool, `${stepName}-${label}`)); stripNotices.push({ label, notice: (await state(page)).notice }) } })
  await sleep(400)
  const after = await state(page)
  const posAfter = await positions(page)
  frames.push(...strips)
  frames.push(await frame(page, tool, `${stepName}-after`))
  const appAfter = await appConsole(page)
  const row = {
    step: stepName, frames, before, after,
    noticeChanged: before.notice !== after.notice,
    noticeOnScreen: await noticeOnScreen(page),
    button: await railButton(page, tool),
    cageChanged: before.points !== after.points || before.faces !== after.faces || before.creases !== after.creases || (farthestMove(posBefore, posAfter) ?? 1) > 1e-6,
    farthestMove: farthestMove(posBefore, posAfter),
    selectionChanged: JSON.stringify(before.selection) !== JSON.stringify(after.selection),
    stripNotices,
    browserConsole: ctx.consoleLines.slice(consoleStart),
    appConsole: appAfter !== appBefore ? appAfter : null,
  }
  log(`[${tool}] ${stepName}: ${before.points}p/${before.faces}f -> ${after.points}p/${after.faces}f, sel ${JSON.stringify(after.selection)}, notice "${after.notice ?? ''}"${row.noticeChanged ? '' : ' (unchanged)'}, on screen: ${row.noticeOnScreen.shown} (${row.noticeOnScreen.why}), move ${row.farthestMove}`)
  let entry = results.find((r) => r.tool === tool)
  if (!entry) { entry = { tool, steps: [] }; results.push(entry) }
  entry.steps.push(row)
  return row
}

/** Pick a visible element of `kind` and click it (real mouse). `choose` picks among the candidates. */
async function select(page, kind, choose = (c) => c[0], { shift = false } = {}) {
  const cands = await pickable(page, kind)
  if (cands.length === 0) throw new Error(`no visible ${kind} to click`)
  const c = choose(cands) ?? cands[0]
  await click(page, c, { shift })
  return c
}
const selCount = (page) => page.evaluate(() => { const s = window.__formStore.getState().selection; return s.points.length + s.edges.length + s.faces.length })
/** Shift+click candidates in turn until the selection grows by one (the gizmo can sit over a spot and take the click). */
async function addToSelection(page, cands) {
  const n = await selCount(page)
  for (const c of cands) {
    await click(page, c, { shift: true })
    const m = await selCount(page)
    if (m === n + 1) return c
    if (m !== n) await click(page, c, { shift: true })
  }
  throw new Error('no Shift+click added to the selection')
}
/** Wheel the view out (a real user zoom) until every world spot projects inside the view with a margin. */
async function zoomToShow(page, worlds) {
  for (let k = 0; k < 12; k++) {
    const ok = await page.evaluate((ws) => {
      const r = document.querySelector('[data-testid="solids-workbench-canvas"]').getBoundingClientRect()
      return ws.every((w) => { const q = window.__formOverlay.screenOf(w); return q.x > 60 && q.y > 60 && q.x < r.width - 60 && q.y < r.height - 60 })
    }, worlds)
    if (ok) return true
    const c = await page.evaluate(() => { const b = document.querySelector('[data-testid="solids-workbench-canvas"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })
    await page.mouse.move(c.x, c.y)
    await page.mouse.wheel(0, 240)
    await sleep(300)
  }
  return false
}
/** Click face corners (world spots on the work plane), one strip frame per click, after zooming them into view. */
async function cornerClicks(page, worlds, snap, label = 'corner') {
  await zoomToShow(page, worlds)
  for (const [i, w] of worlds.entries()) { await clickWorld(page, w); await snap(`${label}${i + 1}`) }
}
const topFace = (c) => c.reduce((a, b) => (b.world[2] > a.world[2] ? b : a))
const verticalEdge = (c) => c.find((e) => Math.abs(e.a[2] - e.b[2]) > 1 && Math.abs(e.a[0] - e.b[0]) < 1e-6 && Math.abs(e.a[1] - e.b[1]) < 1e-6) ?? c[0]

/** Find a page pixel where the gizmo's `axis` handle is under the pointer, scanning out from `from` along `dir`. */
async function findGizmoHandle(page, from, dir, axis) {
  for (let d = 8; d <= 220; d += 4) {
    const x = from.x + dir.x * d, y = from.y + dir.y * d
    await page.mouse.move(x, y)
    await sleep(20)
    const hit = await page.evaluate(() => window.__formInteraction?.gizmoAxis() ?? null)
    if (hit === axis) return { x, y }
  }
  return null
}
async function screenOf(page, world) {
  return page.evaluate((w) => {
    const r = document.querySelector('[data-testid="solids-workbench-canvas"]').getBoundingClientRect()
    const q = window.__formOverlay.screenOf(w)
    return { x: r.left + q.x, y: r.top + q.y }
  }, world)
}
async function dragZ(page, world, dy) {
  const at = await screenOf(page, world)
  const up = await screenOf(page, [world[0], world[1], world[2] + 10])
  const l = Math.hypot(up.x - at.x, up.y - at.y) || 1
  const handle = await findGizmoHandle(page, at, { x: (up.x - at.x) / l, y: (up.y - at.y) / l }, 'Z')
  if (handle === null) return false
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  for (let k = 1; k <= 10; k++) await page.mouse.move(handle.x, handle.y + (dy * k) / 10)
  await page.mouse.up()
  await sleep(400)
  return true
}
/** Click a world spot on a plane (the Face tools take it as a corner). */
async function clickWorld(page, world) {
  const at = await screenOf(page, world)
  await click(page, at)
}

// ---------- the walk ----------


/** Phase start: the Start-from and Edit-form tools with nothing selected, then with the selection Help asks for. */
async function phaseStart(ctx) {
  const { page } = ctx
  const use = (tool) => async () => rail(page, tool)

  // Start from: the five starters (no selection needed: the click is the whole use)
  for (const kind of ['box', 'cylinder', 'sphere', 'torus', 'plane']) {
    const tool = `form-starter-${kind}`
    await fresh(page, kind === 'box' ? 'sphere' : 'box')
    await step(ctx, tool, 'nothing-selected', { act: use(tool) })
  }
  // the sketch/body starters with nothing selected in the tree
  for (const tool of ['form-starter-pipe', 'form-starter-extrude', 'form-starter-revolve', 'form-starter-loft', 'form-starter-body']) {
    await fresh(page)
    await step(ctx, tool, 'nothing-selected', { act: use(tool) })
  }
  // Face: click it, then 4 corners on XY beside the box (a 1 fps style strip, one frame per click)
  await fresh(page)
  await step(ctx, 'form-starter-face', 'nothing-selected', { act: use('form-starter-face') })
  await step(ctx, 'form-starter-face', 'four-corners', {
    act: async ({ snap }) => {
      await cornerClicks(page, [[40, -20, 0], [80, -20, 0], [80, 20, 0], [40, 20, 0]], snap)
      await page.keyboard.press('Escape')
    },
  })

  // Edit form: Move / Rotate / Scale
  for (const [mode] of [['translate'], ['rotate'], ['scale']]) {
    const tool = `form-transform-${mode}`
    await fresh(page)
    await step(ctx, tool, 'nothing-selected', { act: use(tool) })
    await step(ctx, tool, 'top-face-selected', {
      prep: async () => { await select(page, 'face', topFace) },
      act: async () => { await rail(page, tool); if (mode === 'translate') { const s = await page.evaluate(() => { const st = window.__formStore.getState(); const f = st.cage.faces[st.selection.faces[0]]; const P = st.cage.positions; return [0, 1, 2].map((c) => f.reduce((a, v) => a + P[v][c], 0) / f.length) }); ctx.dragged = await dragZ(page, s, -50) } },
    })
  }
  // Flatten / Straighten / Uniform / Pull on a sphere (its faces are not flat, its edges not straight)
  for (const tool of ['form-flatten', 'form-straighten', 'form-make-uniform', 'form-pull']) {
    await fresh(page, 'sphere')
    await step(ctx, tool, 'nothing-selected', { act: use(tool) })
  }
  await fresh(page, 'sphere')
  await step(ctx, 'form-flatten', 'face-selected', { prep: async () => { await clearSelection(page); await select(page, 'face', topFace) }, act: use('form-flatten') })
  await fresh(page, 'sphere')
  await step(ctx, 'form-straighten', 'one-edge-selected', { prep: async () => { await clearSelection(page); await select(page, 'edge') }, act: use('form-straighten') })
  await fresh(page, 'sphere')
  await step(ctx, 'form-straighten', 'two-edges-in-a-chain-selected', {
    prep: async () => {
      await clearSelection(page)
      const first = await select(page, 'edge')
      const ends = first.key.split(':')
      const far = (e) => Math.hypot(e.x - first.x, e.y - first.y)
      const next = (await pickable(page, 'edge')).filter((e) => e.key !== first.key && e.key.split(':').some((v) => ends.includes(v))).sort((p, q) => far(q) - far(p))
      await addToSelection(page, next)
    },
    act: use('form-straighten'),
  })
  await fresh(page, 'sphere')
  await step(ctx, 'form-make-uniform', 'after-a-point-is-dragged', {
    prep: async () => {
      await clearSelection(page)
      // the Move arrows (an earlier tool may have left Rotate or Scale on: the mode outlives the session)
      await rail(page, 'form-transform-translate')
      const p = await select(page, 'point', (c) => c.find((q) => q.world[2] > 30) ?? c[0])
      if (!(await dragZ(page, p.world, -60))) log('[form-make-uniform] the Z arrow was not found: no drag')
      await clearSelection(page)
    },
    act: use('form-make-uniform'),
  })
  await fresh(page, 'sphere')
  await step(ctx, 'form-pull', 'point-selected', { prep: async () => { await clearSelection(page); await select(page, 'point') }, act: use('form-pull') })

}

/** Phase topo: the Topology tools. */
async function phaseTopo(ctx) {
  const { page } = ctx
  const use = (tool) => async () => rail(page, tool)
  const onBoxEdge = (tool, choose = verticalEdge) => ({ prep: async () => { await clearSelection(page); await select(page, 'edge', choose) }, act: use(tool) })
  const onBoxFace = (tool) => ({ prep: async () => { await clearSelection(page); await select(page, 'face', topFace) }, act: use(tool) })
  for (const tool of ['form-insert-loop', 'form-crease', 'form-uncrease', 'form-insert-point', 'form-subdivide', 'form-weld', 'form-weld-close', 'form-unweld']) {
    await fresh(page)
    await step(ctx, tool, 'nothing-selected', { act: use(tool) })
  }
  await fresh(page); await step(ctx, 'form-insert-loop', 'edge-selected', onBoxEdge('form-insert-loop'))
  await fresh(page); await page.click('[data-testid="form-display-smooth"]'); await sleep(300)
  await step(ctx, 'form-crease', 'top-face-selected', onBoxFace('form-crease'))
  await step(ctx, 'form-uncrease', 'top-face-selected', onBoxFace('form-uncrease'))
  await page.click('[data-testid="form-display-both"]')
  await fresh(page); await step(ctx, 'form-insert-point', 'edge-selected', onBoxEdge('form-insert-point'))
  await fresh(page); await step(ctx, 'form-subdivide', 'face-selected', onBoxFace('form-subdivide'))
  await fresh(page, 'plane'); await step(ctx, 'form-weld', 'edge-selected', onBoxEdge('form-weld', (c) => c[Math.floor(c.length / 2)]))
  // Unweld a chain of two edges across the plane, then Weld close joins the doubled points again
  await fresh(page, 'plane')
  const chain = async () => {
    await clearSelection(page)
    // zoom in (wheel over the middle of the plane): the edges grow on screen, the gizmo keeps its size
    const mid = await screenOf(page, [0, 0, 0])
    await page.mouse.move(mid.x, mid.y)
    for (let k = 0; k < 4; k++) { await page.mouse.wheel(0, -240); await sleep(250) }
    const cands = await pickable(page, 'edge')
    const inner = cands.filter((e) => Math.abs(e.a[1]) < 1e-6 && Math.abs(e.b[1]) < 1e-6).sort((p, q) => p.a[0] + p.b[0] - q.a[0] - q.b[0])
    const pair = inner.slice(Math.max(0, Math.floor(inner.length / 2) - 1), Math.floor(inner.length / 2) + 1)
    // the +X edge first: the gizmo's arrows point +X/+Y/+Z from it, so the -X edge stays clear of them
    await click(page, pair[1])
    await addToSelection(page, [pair[0]])
  }
  await step(ctx, 'form-unweld', 'edge-chain-selected', { prep: chain, act: use('form-unweld') })
  await step(ctx, 'form-weld-close', 'after-unweld-nothing-selected', { prep: async () => { await clearSelection(page) }, act: use('form-weld-close') })
  // Add face / Chain: the click-mode tools
  await fresh(page)
  await step(ctx, 'form-add-face', 'nothing-selected', { act: use('form-add-face') })
  await step(ctx, 'form-add-face', 'four-corners', {
    act: async ({ snap }) => {
      await cornerClicks(page, [[40, -20, 0], [70, -20, 0], [70, 20, 0], [40, 20, 0]], snap)
      await page.keyboard.press('Escape')
    },
  })
  await fresh(page)
  await step(ctx, 'form-face-chain', 'nothing-selected', { act: use('form-face-chain') })
  await step(ctx, 'form-face-chain', 'two-chained-faces', {
    act: async ({ snap }) => {
      await cornerClicks(page, [[40, -20, 0], [60, -20, 0], [60, 20, 0], [40, 20, 0], [80, 20, 0], [80, -20, 0]], snap, 'click')
      await page.keyboard.press('Escape')
    },
  })

}

/** Phase selopen: the Select and Openings tools. */
async function phaseSelectOpenings(ctx) {
  const { page } = ctx
  const use = (tool) => async () => rail(page, tool)
  const onBoxEdge = (tool, choose = verticalEdge) => ({ prep: async () => { await clearSelection(page); await select(page, 'edge', choose) }, act: use(tool) })
  const onBoxFace = (tool) => ({ prep: async () => { await clearSelection(page); await select(page, 'face', topFace) }, act: use(tool) })
  for (const tool of ['form-select-loop', 'form-select-ring', 'form-select-grow', 'form-select-shrink', 'form-select-all']) {
    await fresh(page)
    await step(ctx, tool, 'nothing-selected', { act: use(tool) })
  }
  for (const tool of ['form-select-loop', 'form-select-ring']) { await fresh(page); await step(ctx, tool, 'edge-selected', onBoxEdge(tool)) }
  for (const tool of ['form-select-grow', 'form-select-all']) { await fresh(page); await step(ctx, tool, 'face-selected', onBoxFace(tool)) }
  await fresh(page)
  await step(ctx, 'form-select-shrink', 'grown-then-shrink', { prep: async () => { await clearSelection(page); await select(page, 'face', topFace); await rail(page, 'form-select-grow') }, act: use('form-select-shrink') })

  // Openings
  for (const tool of ['form-delete-faces', 'form-fill-hole', 'form-bridge', 'form-thicken']) { await fresh(page); await step(ctx, tool, 'nothing-selected', { act: use(tool) }) }
  await fresh(page); await step(ctx, 'form-delete-faces', 'face-selected', onBoxFace('form-delete-faces'))
  await step(ctx, 'form-fill-hole', 'rim-edge-selected', {
    prep: async () => {
      await clearSelection(page)
      const rim = await page.evaluate(() => {
        const s = window.__formStore.getState(); const uses = new Map()
        for (const f of s.cage.faces) for (let i = 0; i < f.length; i++) { const a = f[i], b = f[(i + 1) % f.length]; const k = a < b ? `${a}:${b}` : `${b}:${a}`; uses.set(k, (uses.get(k) ?? 0) + 1) }
        return [...uses].filter(([, n]) => n === 1).map(([k]) => k)
      })
      await select(page, 'edge', (c) => c.find((e) => rim.includes(e.key)))
    },
    act: use('form-fill-hole'),
  })
  await fresh(page)
  await step(ctx, 'form-bridge', 'two-faces-selected', {
    prep: async () => {
      await clearSelection(page)
      const faces = await pickable(page, 'face')
      let best = null
      for (const a of faces) for (const b of faces) {
        if (a.index >= b.index || a.verts.some((v) => b.verts.includes(v))) continue
        const d = Math.hypot(a.world[0] - b.world[0], a.world[1] - b.world[1], a.world[2] - b.world[2])
        if (best === null || d > best.d) best = { a, b, d }
      }
      await click(page, best.a); await addToSelection(page, [best.b])
    },
    act: use('form-bridge'),
  })
  await fresh(page, 'plane'); await step(ctx, 'form-thicken', 'open-plane', { act: use('form-thicken') })

}

/** Phase symdisp: Symmetry, Display, Undo/Redo. */
async function phaseSymmetryDisplay(ctx) {
  const { page } = ctx
  const use = (tool) => async () => rail(page, tool)
  for (const tool of ['form-mirror-x', 'form-mirror-y', 'form-mirror-z', 'form-circular', 'form-mirror-selection', 'form-mirror-duplicate']) {
    await fresh(page)
    await step(ctx, tool, 'nothing-selected', { act: use(tool) })
  }
  await fresh(page)
  await step(ctx, 'form-mirror-x', 'mirror-on-corner-dragged', {
    prep: async () => { await rail(page, 'form-mirror-x'); await clearSelection(page); await select(page, 'point', (c) => c.find((p) => p.world[0] > 19 && p.world[2] > 39)) },
    act: async () => { const s = await page.evaluate(() => { const st = window.__formStore.getState(); return st.cage.positions[st.selection.points[0]] }); await dragZ(page, s, -50) },
  })
  await fresh(page, 'cylinder')
  await step(ctx, 'form-circular', 'cylinder', { act: use('form-circular') })
  await fresh(page)
  await step(ctx, 'form-mirror-selection', 'two-points-selected', {
    prep: async () => {
      await clearSelection(page)
      const pts = await pickable(page, 'point')
      const a = pts.find((p) => p.world[0] < -19 && p.world[2] > 39) ?? pts[0]
      const b = pts.find((p) => p.world[0] > 19 && Math.abs(p.world[1] - a.world[1]) < 1e-6 && Math.abs(p.world[2] - a.world[2]) < 1e-6) ?? pts[1]
      await click(page, a); await addToSelection(page, [b])
    },
    act: use('form-mirror-selection'),
  })
  await fresh(page)
  await step(ctx, 'form-mirror-duplicate', 'mirror-x-on', { prep: async () => { await rail(page, 'form-mirror-x') }, act: use('form-mirror-duplicate') })

  // Display
  await fresh(page)
  for (const mode of ['smooth', 'cage', 'both']) await step(ctx, `form-display-${mode}`, 'nothing-selected', { act: use(`form-display-${mode}`) })

  // Form history: Undo / Redo appear once there is something to undo / redo
  await fresh(page)
  const undoBefore = await railButton(page, 'form-undo')
  log(`[form-undo] on a fresh form the button is ${undoBefore.present ? 'shown' : 'not shown'}`)
  await step(ctx, 'form-undo', 'after-a-subdivide', { prep: async () => { await clearSelection(page); await select(page, 'face', topFace); await rail(page, 'form-subdivide') }, act: use('form-undo') })
  await step(ctx, 'form-redo', 'after-undo', { act: use('form-redo') })
  results.find((r) => r.tool === 'form-undo').freshForm = { buttonShown: undoBefore.present }
}

/** Phase half: Duplicate on what it is for - half a form, its open side on the mirror plane (made with Face). */
async function phaseHalf(ctx) {
  const { page } = ctx
  await fresh(page)
  await step(ctx, 'form-mirror-duplicate', 'half-form-made-with-face', {
    prep: async () => {
      await rail(page, 'form-starter-face')
      await cornerClicks(page, [[0, -20, 0], [40, -20, 0], [40, 20, 0], [0, 20, 0]], async () => {})
      await page.keyboard.press('Escape')
      await sleep(300)
    },
    act: async () => { await rail(page, 'form-mirror-duplicate') },
  })
}

/** Phase 2: sketches seeded in the project; each sketch starter used the way Help says (select it in the tree). */
async function phaseSketches(ctx) {
  const { page } = ctx
  await page.evaluate(async () => {
    const d = window.__solidsWorkbenchHooks.dag
    const find = (name) => d.nodeIds().find((id) => { const n = d.getNode(id); return n?.kind !== 'sketch' && n?.payload?.name === name })
    const xy = find('XY'), xz = find('XZ')
    const base = d.getNode(xy)
    const raised = (id, name, z) => ({ ...base, id, consumes: [], refs: [], payload: { ...base.payload, name, lastGoodFrame: { ...base.payload.lastGoodFrame, origin: { x: 0, y: 0, z } } } })
    const L = (id, a, b) => ({ id, kind: 'line', construction: false, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } })
    const A = (id, c, r, a0, a1) => ({ id, kind: 'arc', construction: false, center: { x: c[0], y: c[1] }, radius: r, startAngle: a0, endAngle: a1 })
    const C = (id, r) => ({ id, kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: r })
    const sketch = (id, name, plane, entities) => ({ id, kind: 'sketch', consumes: [plane], refs: [], payload: { name, planeNodeId: plane, sketch: { entities, constraints: [], dimensions: [] } } })
    const H = Math.PI / 2
    const nodes = [
      sketch('R2490ARCH', 'Arch', xz, [A('a', [0, 0], 26, 0, Math.PI)]),
      sketch('R2490PLATE', 'Plate profile', xy, [L('p0', [-25, -15], [25, -15]), L('p1', [25, -15], [25, 15]), L('p2', [25, 15], [-25, 15]), L('p3', [-25, 15], [-25, -15])]),
      sketch('R2490VASE', 'Vase profile', xz, [L('v.foot', [0, 0], [15, 0]), L('v.side', [15, 0], [15, 8]), A('v.bulge', [15, 20], 12, -H, H), L('v.neck', [15, 32], [6, 44]), L('v.lip', [6, 44], [0, 44]), L('v.axis', [0, 44], [0, 0])]),
      raised('R2490PL30', 'Plane Z30', 30),
      sketch('R2490LOW', 'Loft base', xy, [C('c', 20)]),
      sketch('R2490HIGH', 'Loft top', 'R2490PL30', [C('c', 8)]),
    ]
    for (const n of nodes) d.insertNode(n)
    await window.__solidsWorkbenchHooks.fullResync(nodes.map((n) => n.id))
  })
  await sleep(1500)
  if (await page.evaluate(() => window.__formStore?.getState().active === true)) { await page.click('[data-testid="form-cancel"]'); await sleep(400) }
  const fromSketch = async (tool, sketchId, stepName, extra) => {
    if (await page.evaluate(() => window.__formStore?.getState().active === true)) { await page.click('[data-testid="form-cancel"]'); await sleep(400) }
    await page.click(`[data-testid="feature-row-${sketchId}"]`)
    await sleep(300)
    await openForm(page)
    await step(ctx, tool, stepName, { act: async ({ snap }) => { await rail(page, tool); if (extra) await extra(snap) } })
  }
  await fromSketch('form-starter-pipe', 'R2490ARCH', 'arch-sketch-selected')
  await fromSketch('form-starter-extrude', 'R2490PLATE', 'plate-sketch-selected')
  await fromSketch('form-starter-revolve', 'R2490VASE', 'vase-sketch-selected')
  await fromSketch('form-starter-loft', 'R2490LOW', 'two-sketches-one-click-each', async (snap) => {
    await snap('first-profile')
    await page.click('[data-testid="feature-row-R2490HIGH"]')
    await sleep(300)
    await rail(page, 'form-starter-loft')
  })
  // Face on a selected plane: the raised plane, four corners on it
  await page.click('[data-testid="form-cancel"]'); await sleep(400)
  await page.click('[data-testid="feature-row-R2490PL30"]').catch(() => log('[face] no tree row for the raised plane'))
  await sleep(300)
  await openForm(page)
  await step(ctx, 'form-starter-face', 'plane-selected-four-corners', {
    act: async ({ snap }) => {
      await rail(page, 'form-starter-face')
      await cornerClicks(page, [[-20, -20, 30], [20, -20, 30], [20, 20, 30], [-20, 20, 30]], snap)
      await page.keyboard.press('Escape')
    },
  })
}

/** Phase 3: a body in the project; From body and Pull to body used the way Help says. */
async function phaseBody(ctx) {
  const { page } = ctx
  if (await page.evaluate(() => window.__formStore?.getState().active === true)) { await page.click('[data-testid="form-cancel"]'); await sleep(400) }
  await page.evaluate(async () => {
    const hooks = window.__solidsWorkbenchHooks
    const plane = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
    const region = { sketchId: 'R2490SK', plane, loops: [[
      { kind: 'line', a: [-30, -18], b: [30, -18], srcId: 'R2490SK.e0' }, { kind: 'line', a: [30, -18], b: [30, 18], srcId: 'R2490SK.e1' },
      { kind: 'line', a: [30, 18], b: [-30, 18], srcId: 'R2490SK.e2' }, { kind: 'line', a: [-30, 18], b: [-30, -18], srcId: 'R2490SK.e3' },
    ]] }
    hooks.dag.insertNode({ id: 'R2490SK', kind: 'sketch', consumes: [], refs: [], payload: { name: 'Block sketch', plane: 'xy', width: 60, height: 36, offset: 0, regions: [region] } })
    hooks.dag.insertNode({ id: 'R2490BLK', kind: 'feature', consumes: ['R2490SK'], refs: [], payload: { opType: 'extrude', sketchId: 'R2490SK', distance: 24, direction: 'up', endCondition: 'blind', boolMode: 'newBody', name: 'Block' } })
    await hooks.fullResync(['R2490SK', 'R2490BLK'])
  })
  await page.waitForFunction(() => window.__solidsWorkbenchHooks.getBodyHandle('R2490BLK') !== undefined, null, { timeout: 180_000 })
  await sleep(800)
  // Pull to body with no body row clicked first (Help: "else the only body" - but there are none other)
  await openForm(page)
  await step(ctx, 'form-pull-body', 'nothing-selected-one-body-in-project', { act: async () => { await rail(page, 'form-pull-body'); await sleep(800) } })
  await page.click('[data-testid="form-cancel"]'); await sleep(400)
  await page.click('[data-testid="body-row-R2490BLK"]').catch(() => log('[body] no body row to click'))
  await sleep(300)
  await openForm(page)
  await step(ctx, 'form-pull-body', 'body-selected-in-tree', { act: async () => { await rail(page, 'form-pull-body'); await sleep(800) } })
  await step(ctx, 'form-starter-body', 'body-selected-in-tree', { act: async () => { await rail(page, 'form-starter-body'); await sleep(1500) } })
}

/** The rail and palette as a whole: which buttons are on screen, and the status line with every palette group open. */
async function layoutFacts(ctx) {
  const { page } = ctx
  await fresh(page)
  const facts = await page.evaluate(() => {
    const rail = [...document.querySelectorAll('[data-testid^="workbench-rail-section-form-"] button[data-testid]')].map((b) => {
      const r = b.getBoundingClientRect()
      return { testId: b.getAttribute('data-testid'), label: (b.textContent ?? '').trim(), onScreen: r.top >= 0 && r.bottom <= window.innerHeight, title: b.getAttribute('title') ?? b.getAttribute('data-tooltip') }
    })
    return { rail, viewport: { w: window.innerWidth, h: window.innerHeight } }
  })
  facts.railScrolls = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="workbench-rail-section-form-create"]')
    for (let p = el?.parentElement ?? null; p !== null; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight) return { scrolls: true, hiddenPx: p.scrollHeight - p.clientHeight, scrollbarShown: p.offsetWidth > p.clientWidth }
    }
    return { scrolls: false }
  })
  facts.frameRail = await frame(page, 'layout', 'rail-at-1600x900')
  await rail(page, 'form-select-grow')
  facts.noticeConsoleFolded = await noticeOnScreen(page)
  // the Model console opened (its strip at the foot of the screen is one click away): where does the status line go
  facts.consoleStripClick = await page.click('[data-testid="console-strip"] >> visible=true', { timeout: 5000 }).then(() => 'clicked', (e) => `covered: ${e.message.split(/\r?\n/).find((l) => /intercepts/.test(l))?.trim() ?? 'not clickable'}`)
  if (facts.consoleStripClick !== 'clicked') await page.click('[data-testid="console-strip"] >> visible=true', { force: true })
  await sleep(400)
  await rail(page, 'form-select-shrink')
  facts.noticeConsoleOpen = await noticeOnScreen(page)
  facts.frameConsoleOpen = await frame(page, 'layout', 'status-line-with-console-open')
  await page.click('[data-testid="console-strip"] >> visible=true', { force: true })
  await sleep(300)
  log(`[layout] ${facts.rail.filter((b) => !b.onScreen).length} of ${facts.rail.length} rail buttons below the window (rail scrolls: ${JSON.stringify(facts.railScrolls)}); status line, console folded: ${JSON.stringify(facts.noticeConsoleFolded)}; console open: ${JSON.stringify(facts.noticeConsoleOpen)}`)
  return facts
}

const PHASES = { start: phaseStart, topo: phaseTopo, selopen: phaseSelectOpenings, symdisp: phaseSymmetryDisplay, half: phaseHalf, sketches: phaseSketches, body: phaseBody, layout: null }
if (!(PHASE in PHASES)) throw new Error(`no phase "${PHASE}" (have: ${Object.keys(PHASES).join(', ')})`)

await withViteCaptureServer({ port: PORT, repoRoot: REPO_ROOT, timeoutMs: 240_000 }, async ({ baseUrl }) => {
  const exe = process.env.FORM_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)
  const browser = await chromium.launch({ headless: HEADLESS, args: LAUNCH_ARGS, executablePath: exe, ignoreDefaultArgs: ['--hide-scrollbars'] })
  const consoleLines = []
  let layout = null
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })

    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text().slice(0, 400)}`) })
    page.on('pageerror', (e) => consoleLines.push(`page error: ${e.message}`))
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForFunction(() => window.__camStore !== undefined, null, { timeout: 120_000 })
    await dismissMachineModal(page)
    await page.click('[data-testid="mode-tab-part"]')
    await page.waitForSelector('[data-testid="solids-workbench-canvas"]', { state: 'visible', timeout: 120_000 })
    await page.waitForFunction(() => /ready/i.test(document.querySelector('[data-testid="solids-workbench-status"]')?.textContent ?? ''), null, { timeout: 180_000 })
    const ctx = { page, consoleLines, log }
      try { if (PHASE === 'layout') layout = await layoutFacts(ctx); else await PHASES[PHASE](ctx) } catch (e) { log(`[phase ${PHASE}] STOPPED: ${e.stack ?? e}`) }
  } finally {
    writeFileSync(path.join(OUT, `results-${PHASE}.json`), `${JSON.stringify({ phase: PHASE, headless: HEADLESS, viewport: VIEWPORT, layout, tools: results }, null, 2)}\n`)
    writeFileSync(path.join(OUT, `run-log-${PHASE}.txt`), `${runLog.join('\n')}\n\n--- browser console (errors and warnings) ---\n${consoleLines.join('\n')}\n`)
    await browser.close()
  }
})
