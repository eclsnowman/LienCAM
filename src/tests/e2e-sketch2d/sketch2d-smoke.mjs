#!/usr/bin/env node
/**
 * sketch2d-smoke.mjs -- WO SKC-6C 2D-CAM real-app Playwright harness.
 *
 * Sibling of tools/smoke/lab3d-smoke.mjs (same self-heal Chromium launch +
 * Windows-safe process-tree kill + vite-dev-server-per-run pattern) but
 * drives the REAL 2D CAM SKETCHER UI (mouse clicks on the actual canvas +
 * toolbox buttons, not stores/unit seams) through six flows:
 *   1. Create a sketch: rectangle + circle + line; dimension them (linear,
 *      diameter, angular); edit a dimension and confirm the entity moves.
 *   2. Constraints: coincident, horizontal, tangent; confirm solved
 *      positions.
 *   3. Driving vs reference dimensions: confirm a reference dimension edit
 *      is REJECTED (never pushes geometry) while a driving edit on another
 *      dimension DOES move geometry.
 *   4. Unconstrained drag: drag a free point, confirm it lands at the drop
 *      point (wall-clock recorded as a labeled proxy -- no solve-timing
 *      hook exists in the app, see README).
 *   5. Downstream CAM check: bake the sketch, read the New-Operation
 *      modal's per-loop area readout for the rectangle, edit a driving
 *      dimension on the rectangle, re-bake, and confirm the readout
 *      changed.
 *   6. Golden gate: every asserted numeric value is assembled into one
 *      object and written to a RUN-LOCAL file (golden-run.local.json,
 *      gitignored -- never the committed truth). That run-local capture is
 *      then diffed field-by-field against the COMMITTED golden
 *      (coordination/evidence/SKC-6C/golden-baseline.json) using a
 *      per-field tolerance table measured from real run-to-run jitter (see
 *      TOLERANCES below); any field outside its tolerance throws and exits
 *      nonzero, naming the field. The harness itself NEVER writes the
 *      committed golden -- the only way to update it is an explicit
 *      `--rebaseline` flag, which prints a loud warning before overwriting
 *      it. This makes the golden a GATE (can fail) instead of a diary that
 *      re-baselines itself every run (BK-90).
 *
 * Run from repo root:  node src/tests/e2e-sketch2d/sketch2d-smoke.mjs
 * Re-baseline (writes the committed golden -- use deliberately, then review
 * the diff before committing):
 *   node src/tests/e2e-sketch2d/sketch2d-smoke.mjs --rebaseline
 * See src/tests/e2e-sketch2d/README.md for selector conventions, the
 * golden JSON schema, and why store reads (window.__camStore) are used
 * for assertions alongside real mouse/keyboard-driven actions.
 *
 * Exit codes: 0 = pass, 1 = a real failure (assertion, console/page error,
 * missing evidence, or a golden-gate mismatch/drift beyond tolerance).
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../..')
const EVIDENCE_DIR = path.join(REPO_ROOT, 'coordination', 'evidence', 'SKC-6C')
const GOLDEN_PATH = path.join(EVIDENCE_DIR, 'golden-baseline.json')
const RUN_LOCAL_PATH = path.join(EVIDENCE_DIR, 'golden-run.local.json')
const REBASELINE = process.argv.includes('--rebaseline')
const PORT = 4192
const BASE_URL = `http://localhost:${PORT}/`

// Seam-level guard (INT-H6-R2): a non-finite/NaN SKETCH2D_SMOKE_PERTURB_DELTA
// would silently poison the golden-gate comparison after a ~2-minute browser
// run. Reject it immediately, before the dev server or browser ever starts.
if (process.env.SKETCH2D_SMOKE_PERTURB_DELTA !== undefined) {
  const rawDelta = Number(process.env.SKETCH2D_SMOKE_PERTURB_DELTA)
  if (typeof rawDelta !== 'number' || !Number.isFinite(rawDelta)) {
    throw new Error(
      `SKETCH2D_SMOKE_PERTURB_DELTA=${JSON.stringify(process.env.SKETCH2D_SMOKE_PERTURB_DELTA)} is not a finite number -- refusing to run (would poison the golden gate)`,
    )
  }
}

// ---- generic process/server plumbing (mirrors tools/smoke/lab3d-smoke.mjs) ----

function waitForServer(url, timeoutMs = 60_000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(url, (res) => { res.resume(); resolve() })
        .on('error', () => {
          if (Date.now() - start > timeoutMs) reject(new Error(`dev server did not come up at ${url}`))
          else setTimeout(tick, 300)
        })
    }
    tick()
  })
}

function runToCompletion(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, shell: true, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))
    })
  })
}

async function tryLaunchChromium() {
  try {
    return await chromium.launch()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/Executable doesn't exist/.test(message)) throw err
    console.log('[sketch2d-smoke] Chromium executable not found -- running "npx playwright install chromium" once...')
    await runToCompletion('npx', ['playwright', 'install', 'chromium'])
    console.log('[sketch2d-smoke] install complete, retrying launch...')
    return await chromium.launch()
  }
}

function killTree(pid) {
  try {
    if (process.platform !== 'win32') { process.kill(pid, 'SIGKILL'); return }
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    killer.once('error', () => {})
  } catch {
    /* best effort */
  }
}

// ---- assertion helper --------------------------------------------------------

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}

function approxEqual(a, b, eps = 0.05) {
  return Math.abs(a - b) <= eps
}

// JSON.stringify(NaN) === 'null', which would make a NaN value visually
// indistinguishable from an actual null in an error message. Represent
// non-finite numbers by their literal name instead of routing them through
// JSON.stringify's silent null-coercion.
function numRepr(v) {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v)
  return JSON.stringify(v)
}

// Clicks resolve through screen-pixel -> world-mm rounding (sub-mm), so
// entity lookups by their nominal drawn coordinates need a tolerance --
// never exact equality.
function near(a, b, eps = 0.5) {
  return Math.abs(a - b) <= eps
}

// A single-line-body smart-dim pick commits as the orientation-blind
// 'distance' kind (dimTool.ts planDimension), but the placement click's
// drag vector then resolves it to 'distanceX'/'distanceY' when the line is
// axis-aligned (dimTool.ts resolveDimPlacement) -- all three still
// constrain the same single length freedom for an axis-aligned line, so
// any of them is a valid "linear dimension" for this harness's purposes.
function isLinearKind(k) {
  return k === 'distance' || k === 'distanceX' || k === 'distanceY'
}

// ---- viewport / canvas coordinate + click helpers ---------------------------
// The sketch UI has NO data-testid hooks on its toolbox/canvas (confirmed by
// recon grep) -- selectors are visible button text + className, matching the
// only pattern the shipped UI actually offers. window.__cncViewport is
// unconditionally exposed (Viewport.tsx) and worldToScreen() returns
// CONTAINER-relative CSS px (not page-relative), so every click adds the
// live .viewport-canvas bounding rect.

async function worldToClientPoint(page, x, y) {
  return page.evaluate(([wx, wy]) => {
    const el = document.querySelector('.viewport-canvas')
    const rect = el.getBoundingClientRect()
    const s = window.__cncViewport.worldToScreen(wx, wy)
    return { x: rect.left + s.x, y: rect.top + s.y }
  }, [x, y])
}

async function clickWorld(page, x, y) {
  const p = await worldToClientPoint(page, x, y)
  await page.mouse.click(p.x, p.y)
}

async function shiftClickWorld(page, x, y) {
  const p = await worldToClientPoint(page, x, y)
  await page.keyboard.down('Shift')
  await page.mouse.click(p.x, p.y)
  await page.keyboard.up('Shift')
}

/** Click a toolbox/modal button by its EXACT visible label text -- the only
 *  reliable selector this UI offers (no data-testid on the sketch toolbox). */
async function clickButton(page, name) {
  await page.getByRole('button', { name, exact: true }).click()
}

/** Arm a CREATE tool, click each [x,y] world point, then click the SAME
 *  button again to disarm back to 'select' (armed-tool toggle doctrine --
 *  SketchToolbox.tsx: onClick sets tool to 'select' whenever the clicked
 *  tool is already armed, regardless of in-progress chain state). Already-
 *  committed entities from the clicks survive the disarm. */
async function useCreateTool(page, label, points) {
  await clickButton(page, label)
  for (const [x, y] of points) await clickWorld(page, x, y)
  await clickButton(page, label)
}

/** Smart-dimension pick sequence: 1-2 operand clicks on entities, then one
 *  placement click in empty space. Tool must already be armed (call
 *  clickButton(page, 'Smart Dim.') once before a batch of these). */
async function addDimension(page, picks, labelPos) {
  for (const [x, y] of picks) await clickWorld(page, x, y)
  await clickWorld(page, labelPos[0], labelPos[1])
  // Placing a new dimension auto-opens its value editor (store.ts
  // sketchToolClick: `sketchDimEditor: { dimId, isNew: true }`) so the user
  // can type a value immediately. The editor DIV sits on top of the canvas
  // and would otherwise swallow the next flow's clicks -- Escape closes it
  // (SketchDimensionOverlay: Escape -> closeDimensionEditor()) without
  // touching the just-placed value.
  await page.keyboard.press('Escape')
}

/** Apply a constraint to the selection: plain click on the first entity
 *  point, shift-click each additional entity point, then click the
 *  constraint action button (SketchToolbox.tsx CONSTRAINT_KIND_BY_BUTTON). */
async function applyConstraint(page, label, entityPoints) {
  const [first, ...rest] = entityPoints
  await clickWorld(page, first[0], first[1])
  for (const p of rest) await shiftClickWorld(page, p[0], p[1])
  await clickButton(page, label)
}

// ---- store read helpers (read-only inspection of the SAME store the real
// UI drives -- window.__camStore is a dev-only but unconditional escape
// hatch (demoSeed.ts), not a test stub; every ACTION in this harness goes
// through real mouse/keyboard events, only ASSERTIONS read the store) -------

async function readSketch(page) {
  return page.evaluate(() => {
    const s = window.__camStore.getState()
    const sk = s.activeSketch
    if (!sk) return null
    const status = s.sketchSolveStatus ?? sk.solveStatus
    return {
      entities: sk.entities,
      dimensions: sk.dimensions,
      constraints: sk.constraints,
      dof: status ? status.dof : null,
      conflicting: status ? status.conflicting : [],
      redundant: status ? status.redundant : [],
      solveFailed: status ? !!status.solveFailed : false,
    }
  })
}

/** Read the real DOM definedness chip (SketchToolbox.tsx SketchDefinitionChip
 *  -- `.sketch-def-chip`, classed `-defined`/`-under`/`-failed`/`-idle`, text
 *  "Fully defined" / "N DoF" / "Solve failed" / "Solving..."). This is the
 *  fully-constrained indicator the WO requires flow 2 to assert against, not
 *  just the underlying store field. */
async function readDefChip(page) {
  const el = page.locator('.sketch-def-chip')
  await el.waitFor({ state: 'visible', timeout: 5000 })
  const className = await el.getAttribute('class')
  const text = (await el.textContent()).trim()
  const dofMatch = /^(\d+) DoF$/.exec(text)
  return {
    className,
    text,
    isFullyDefined: className.includes('sketch-def-chip-defined'),
    isUnderDefined: className.includes('sketch-def-chip-under'),
    isFailed: className.includes('sketch-def-chip-failed'),
    domDof: dofMatch ? Number(dofMatch[1]) : null,
  }
}

/** Poll the store until two consecutive reads agree (the async worker solve
 *  has settled), or throw after timeoutMs. No solve-timing hook exists in
 *  the app (confirmed by recon) so polling is the only option. */
async function waitForSolveSettled(page, { timeoutMs = 8000, pollMs = 100 } = {}) {
  const start = Date.now()
  let prev = JSON.stringify(await readSketch(page))
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs))
    const cur = JSON.stringify(await readSketch(page))
    if (cur === prev) return JSON.parse(cur)
    prev = cur
  }
  throw new Error('sketch solve did not settle within timeout')
}

function findEntity(sketch, pred) {
  return sketch.entities.find(pred)
}

/** The dimension NOT present in `beforeIds` -- used to identify a
 *  just-created dimension without threading ids through click sequences. */
function newDimensionId(sketch, beforeIds) {
  const d = sketch.dimensions.find((x) => !beforeIds.has(x.id))
  assert(d, 'no new dimension appeared after the placement click')
  return d
}

async function editDimension(page, dimId, newValue) {
  await page.locator(`[data-dim-id="${dimId}"]`).dblclick()
  const input = page.locator('.sketch-dim-input')
  await input.waitFor({ state: 'visible', timeout: 5000 })
  await input.fill(String(newValue))
  await input.press('Enter')
}

async function toggleDimReference(page, dimId) {
  await page.locator(`[data-dim-id="${dimId}"]`).click()
  await clickButton(page, 'Reference')
}

// ---- main ---------------------------------------------------------------

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true })
  const shot = (n) => path.join(EVIDENCE_DIR, n)
  const baseline = {}

  console.log('[sketch2d-smoke] starting vite dev server (no prior build required)...')
  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: REPO_ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverOutput = ''
  server.stdout.on('data', (d) => (serverOutput += d.toString()))
  server.stderr.on('data', (d) => (serverOutput += d.toString()))

  let browser
  try {
    await waitForServer(BASE_URL)
    console.log('[sketch2d-smoke] dev server up, launching chromium...')
    browser = await tryLaunchChromium()
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(`[pageerror] ${err.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`[console.error] ${msg.text()}`)
    })

    console.log(`[sketch2d-smoke] navigating to ${BASE_URL}`)
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.mode-tab-strip', { timeout: 30_000 })

    // ---- Enter sketch mode (New sketch) ----------------------------------
    console.log('[sketch2d-smoke] entering sketch mode (New sketch)...')
    await page.locator('[data-tooltip="Sketch mode"]').click()
    await page.locator('.sketch-entry-new').click()
    await page.waitForSelector('.sketch-toolbox', { timeout: 15_000 })

    // ================= FLOW 1: create + dimension =========================
    console.log('[sketch2d-smoke] FLOW 1: rectangle + circle + line, dimensioned...')
    await useCreateTool(page, 'Rectangle', [[0, 0], [60, 40]])
    await useCreateTool(page, 'Circle', [[110, 20], [125, 20]])
    await useCreateTool(page, 'Line', [[0, 80], [60, 80]])
    // A freestanding, deliberately non-axis-aligned line for the ANGULAR
    // dimension below -- dimensioning the angle between the rectangle's OWN
    // adjacent (already H+V constrained) sides would be a REDUNDANT
    // constraint (implied by H+V), and a redundant angle constraint on the
    // rectangle was observed to make its solve stop tracking a later length
    // edit (flow 5's re-bake) even though the solver reports no conflict.
    // An angle to this independent line has no such interaction.
    await useCreateTool(page, 'Line', [[85, -40], [95, -25]])

    let sk = await waitForSolveSettled(page)
    const line0 = findEntity(sk, (e) => e.kind === 'line' && near(e.start.x, 0) && near(e.start.y, 0))
    const line1 = findEntity(sk, (e) => e.kind === 'line' && near(e.start.x, 60) && near(e.start.y, 0))
    const circle0 = findEntity(sk, (e) => e.kind === 'circle')
    const lineL1 = findEntity(sk, (e) => e.kind === 'line' && near(e.start.x, 0) && near(e.start.y, 80))
    const lineAngleRef = findEntity(sk, (e) => e.kind === 'line' && near(e.start.x, 85) && near(e.start.y, -40))
    assert(line0 && line1 && circle0 && lineL1 && lineAngleRef, 'expected rectangle sides + circle + standalone lines not found in store')

    await clickButton(page, 'Smart Dim.')
    // DIM_D: rectangle bottom-line LENGTH (dedicated -- flow 5 edits this one).
    let beforeIds = new Set(sk.dimensions.map((d) => d.id))
    await addDimension(page, [[15, 0]], [15, -15])
    sk = await waitForSolveSettled(page)
    const dimD = newDimensionId(sk, beforeIds)
    assert(isLinearKind(dimD.kind), `DIM_D expected a linear dim kind, got ${dimD.kind}`)
    assert(approxEqual(dimD.value, 60), `DIM_D expected ~60mm, got ${dimD.value}`)

    // DIM_E: rectangle right-side LENGTH, pinning the height so flow 5's
    // width-only edit (DIM_D) produces a deterministic area (width x 40)
    // instead of an under-determined height the solver is free to
    // redistribute arbitrarily.
    beforeIds = new Set(sk.dimensions.map((d) => d.id))
    await addDimension(page, [[60, 20]], [80, 20])
    sk = await waitForSolveSettled(page)
    const dimE = newDimensionId(sk, beforeIds)
    assert(isLinearKind(dimE.kind), `DIM_E expected a linear dim kind, got ${dimE.kind}`)
    assert(approxEqual(dimE.value, 40), `DIM_E expected ~40mm, got ${dimE.value}`)

    // DIM_C: angle between the rectangle's bottom side and the freestanding
    // non-parallel/non-perpendicular line above.
    const expectedAngleDeg = Math.abs(
      (Math.atan2(60 * 15 - 0 * 10, 60 * 10 + 0 * 15) * 180) / Math.PI,
    ) // lineAngle(line0 dir (60,0), lineAngleRef dir (10,15): (85,-40)->(95,-25)) -- dimTool.ts lineAngle
    beforeIds = new Set(sk.dimensions.map((d) => d.id))
    await addDimension(page, [[45, 0], [90, -32.5]], [85, -55])
    sk = await waitForSolveSettled(page)
    const dimC = newDimensionId(sk, beforeIds)
    assert(dimC.kind === 'angle', `DIM_C expected kind angle, got ${dimC.kind}`)
    const dimCdeg = Math.abs((dimC.value * 180) / Math.PI)
    assert(approxEqual(dimCdeg, expectedAngleDeg, 0.5), `DIM_C expected ~${expectedAngleDeg.toFixed(1)}deg, got ${dimCdeg}`)

    // DIM_B: circle diameter. Placement well clear of the circle boundary
    // (>= 15mm, matching DIM_D/DIM_C's margins) -- the auto-fit camera's
    // world-per-pixel scales the pick/placement tolerance in world mm, so a
    // placement click must clear more than just the nominal geometry gap.
    beforeIds = new Set(sk.dimensions.map((d) => d.id))
    await addDimension(page, [[125, 20]], [110, 55])
    sk = await waitForSolveSettled(page)
    const dimB = newDimensionId(sk, beforeIds)
    assert(dimB.kind === 'diameter', `DIM_B expected kind diameter, got ${dimB.kind}`)
    assert(approxEqual(dimB.value, 30), `DIM_B expected ~30mm, got ${dimB.value}`)

    // DIM_A: standalone line length (edited below to prove edit->geometry move).
    beforeIds = new Set(sk.dimensions.map((d) => d.id))
    await addDimension(page, [[30, 80]], [30, 95])
    sk = await waitForSolveSettled(page)
    const dimA = newDimensionId(sk, beforeIds)
    assert(isLinearKind(dimA.kind), `DIM_A expected a linear dim kind, got ${dimA.kind}`)
    assert(approxEqual(dimA.value, 60), `DIM_A expected ~60mm, got ${dimA.value}`)
    await clickButton(page, 'Smart Dim.') // disarm back to select

    await page.screenshot({ path: shot('01-sketch-created.png') })
    console.log('[sketch2d-smoke] wrote 01-sketch-created.png')

    console.log('[sketch2d-smoke] editing DIM_A 60 -> 80mm, confirming the line moves...')
    await editDimension(page, dimA.id, 80)
    sk = await waitForSolveSettled(page)
    const lineL1After = findEntity(sk, (e) => e.id === lineL1.id)
    const lenAfter = Math.hypot(lineL1After.end.x - lineL1After.start.x, lineL1After.end.y - lineL1After.start.y)
    assert(approxEqual(lenAfter, 80, 0.1), `expected L1 length ~80mm after edit, got ${lenAfter}`)
    const dimAafter = sk.dimensions.find((d) => d.id === dimA.id)
    assert(approxEqual(dimAafter.value, 80, 0.1), `DIM_A label expected 80, got ${dimAafter.value}`)

    await page.screenshot({ path: shot('02-dimension-edited.png') })
    console.log('[sketch2d-smoke] wrote 02-dimension-edited.png')

    baseline.flow1 = {
      rectangleLine0Length: 60, rectangleAngleDeg: dimCdeg,
      circleDiameter: dimB.value, lineL1LengthAfterEdit: lenAfter,
    }

    // ================= FLOW 2: constraints =================================
    console.log('[sketch2d-smoke] FLOW 2: coincident, horizontal, tangent...')
    await useCreateTool(page, 'Point', [[100, 80], [115, 95]])
    await useCreateTool(page, 'Line', [[150, 0], [165, 15]])   // diagonal -> Horizontal
    await useCreateTool(page, 'Line', [[150, 80], [150, 110]]) // vertical, near-tangent target
    await useCreateTool(page, 'Circle', [[175, 95], [183, 95]]) // r=8, not touching the line above

    sk = await waitForSolveSettled(page)
    const p1 = findEntity(sk, (e) => e.kind === 'point' && near(e.at.x, 100) && near(e.at.y, 80))
    const p2 = findEntity(sk, (e) => e.kind === 'point' && near(e.at.x, 115) && near(e.at.y, 95))
    const lineDiag = findEntity(sk, (e) => e.kind === 'line' && near(e.start.x, 150) && near(e.start.y, 0))
    const lineVert = findEntity(sk, (e) => e.kind === 'line' && near(e.start.x, 150) && near(e.start.y, 80))
    const circleTan = findEntity(sk, (e) => e.kind === 'circle' && near(e.center.x, 175, 1) && near(e.center.y, 95, 1))
    assert(p1 && p2 && lineDiag && lineVert && circleTan, 'flow2 seed entities not found in store')

    console.log('[sketch2d-smoke]   coincident: two free points -> merge...')
    const dofBeforeCoincident = sk.dof
    await applyConstraint(page, 'Coincident', [[100, 80], [115, 95]])
    sk = await waitForSolveSettled(page)
    assert(sk.conflicting.length === 0, `coincident produced a conflict: ${JSON.stringify(sk.conflicting)}`)
    const p1b = findEntity(sk, (e) => e.id === p1.id)
    const p2b = findEntity(sk, (e) => e.id === p2.id)
    const pointGap = Math.hypot(p1b.at.x - p2b.at.x, p1b.at.y - p2b.at.y)
    assert(pointGap < 1e-3, `coincident points did not merge, gap=${pointGap}`)
    // Definedness/fully-constrained indicator (SketchDefinitionChip, the real
    // DOM readout the WO requires flow 2 to assert against, not just the
    // underlying store field it's derived from).
    let chip = await readDefChip(page)
    assert(!chip.isFailed, `definedness chip shows solve failed after coincident: ${chip.text}`)
    assert(chip.domDof === sk.dof, `definedness chip shows ${chip.domDof} DoF, store reports ${sk.dof}`)
    assert(sk.dof === dofBeforeCoincident - 2,
      `expected coincident to remove 2 DoF (merge two free points), dof ${dofBeforeCoincident} -> ${sk.dof}`)
    const dofAfterCoincident = sk.dof

    console.log('[sketch2d-smoke]   horizontal: diagonal line -> dy=0...')
    await applyConstraint(page, 'Horizontal', [[157.5, 7.5]])
    sk = await waitForSolveSettled(page)
    assert(sk.conflicting.length === 0, `horizontal produced a conflict: ${JSON.stringify(sk.conflicting)}`)
    const lineDiagAfter = findEntity(sk, (e) => e.id === lineDiag.id)
    const dy = Math.abs(lineDiagAfter.end.y - lineDiagAfter.start.y)
    assert(dy < 1e-3, `expected horizontal line dy~0, got ${dy}`)
    chip = await readDefChip(page)
    assert(!chip.isFailed, `definedness chip shows solve failed after horizontal: ${chip.text}`)
    assert(chip.domDof === sk.dof, `definedness chip shows ${chip.domDof} DoF, store reports ${sk.dof}`)
    assert(sk.dof === dofAfterCoincident - 1,
      `expected horizontal to remove 1 DoF, dof ${dofAfterCoincident} -> ${sk.dof}`)
    const dofAfterHorizontal = sk.dof

    console.log('[sketch2d-smoke]   tangent: line + circle -> distance == radius...')
    await applyConstraint(page, 'Tangent', [[150, 95], [183, 95]])
    sk = await waitForSolveSettled(page)
    assert(sk.conflicting.length === 0, `tangent produced a conflict: ${JSON.stringify(sk.conflicting)}`)
    const lineVertAfter = findEntity(sk, (e) => e.id === lineVert.id)
    const circleTanAfter = findEntity(sk, (e) => e.id === circleTan.id)
    const lineX = (lineVertAfter.start.x + lineVertAfter.end.x) / 2
    const tanGap = Math.abs(circleTanAfter.center.x - lineX) - circleTanAfter.radius
    assert(Math.abs(tanGap) < 0.05, `expected tangent (center-to-line distance == radius), residual=${tanGap}`)
    chip = await readDefChip(page)
    assert(!chip.isFailed, `definedness chip shows solve failed after tangent: ${chip.text}`)
    assert(chip.domDof === sk.dof, `definedness chip shows ${chip.domDof} DoF, store reports ${sk.dof}`)
    assert(sk.dof === dofAfterHorizontal - 1,
      `expected tangent to remove 1 DoF, dof ${dofAfterHorizontal} -> ${sk.dof}`)
    const dofAfterTangent = sk.dof
    assert(chip.isUnderDefined, `expected the sketch to still be under-defined after flow 2 (many free entities remain), chip=${chip.text}`)

    await page.screenshot({ path: shot('03-constraints-applied.png') })
    console.log('[sketch2d-smoke] wrote 03-constraints-applied.png')

    baseline.flow2 = {
      coincidentGap: pointGap, horizontalDy: dy, tangentResidual: tanGap,
      dofAfterCoincident, dofAfterHorizontal, dofAfterTangent,
    }

    // ================= FLOW 3: driving vs reference ========================
    console.log('[sketch2d-smoke] FLOW 3: reference edit rejected, driving edit moves geometry...')
    await toggleDimReference(page, dimA.id)
    sk = await waitForSolveSettled(page)
    const dimARef = sk.dimensions.find((d) => d.id === dimA.id)
    assert(dimARef.driving === false, 'DIM_A did not toggle to reference')
    const lineL1BeforeBadEdit = findEntity(sk, (e) => e.id === lineL1.id)
    const lenBeforeBadEdit = Math.hypot(
      lineL1BeforeBadEdit.end.x - lineL1BeforeBadEdit.start.x,
      lineL1BeforeBadEdit.end.y - lineL1BeforeBadEdit.start.y,
    )

    // A reference dimension's value INPUT itself is disabled in the real UI
    // (DimValueInput: `disabled={!dim.driving}`) -- there is no keystroke
    // that can even reach it (it also never auto-focuses, unlike a driving
    // dim's editor). This is the real-UI proof "reference dims never push
    // geometry": the edit path is unreachable, not merely store-rejected.
    await page.locator(`[data-dim-id="${dimA.id}"]`).dblclick()
    const refInput = page.locator('.sketch-dim-input')
    await refInput.waitFor({ state: 'visible', timeout: 5000 })
    assert(await refInput.isDisabled(), 'reference dimension input should be disabled (uneditable)')
    const refValueAttr = await refInput.getAttribute('value')
    assert(approxEqual(parseFloat(refValueAttr), lenBeforeBadEdit, 0.01),
      `reference dim input should show the measured value, got ${refValueAttr}`)

    const lineL1AfterBadEdit = findEntity(sk, (e) => e.id === lineL1.id)
    const lenAfterBadEdit = Math.hypot(
      lineL1AfterBadEdit.end.x - lineL1AfterBadEdit.start.x,
      lineL1AfterBadEdit.end.y - lineL1AfterBadEdit.start.y,
    )
    assert(approxEqual(lenAfterBadEdit, lenBeforeBadEdit, 0.01),
      `reference dim should not have moved geometry just by opening its (disabled) editor: before=${lenBeforeBadEdit} after=${lenAfterBadEdit}`)

    console.log('[sketch2d-smoke]   driving edit (DIM_B diameter 30 -> 45) DOES move geometry...')
    await editDimension(page, dimB.id, 45)
    sk = await waitForSolveSettled(page)
    const circle0After = findEntity(sk, (e) => e.id === circle0.id)
    assert(approxEqual(circle0After.radius * 2, 45, 0.1), `expected circle diameter 45 after driving edit, got ${circle0After.radius * 2}`)
    // The reference dim must STILL be untouched by an unrelated driving edit.
    const lineL1Final = findEntity(sk, (e) => e.id === lineL1.id)
    const lenFinal = Math.hypot(lineL1Final.end.x - lineL1Final.start.x, lineL1Final.end.y - lineL1Final.start.y)
    assert(approxEqual(lenFinal, lenBeforeBadEdit, 0.01), 'reference-dim line moved from an unrelated driving edit elsewhere')

    await page.screenshot({ path: shot('04-driving-vs-reference.png') })
    console.log('[sketch2d-smoke] wrote 04-driving-vs-reference.png')

    baseline.flow3 = {
      referenceDimRejectedEditLength: lenAfterBadEdit,
      drivingDimAppliedDiameter: circle0After.radius * 2,
    }

    // ================= FLOW 4: unconstrained drag ===========================
    console.log('[sketch2d-smoke] FLOW 4: dragging a free point...')
    await useCreateTool(page, 'Point', [[220, 20]])
    sk = await waitForSolveSettled(page)
    const dragPoint = findEntity(sk, (e) => e.kind === 'point' && near(e.at.x, 220) && near(e.at.y, 20))
    assert(dragPoint, 'drag-test point not found in store')

    const dragFrom = await worldToClientPoint(page, 220, 20)
    const dragTo = await worldToClientPoint(page, 235, 35)
    const dragT0 = Date.now()
    await page.mouse.move(dragFrom.x, dragFrom.y)
    await page.mouse.down()
    // Chromium coalesces mousemove events dispatched faster than a rendered
    // frame, so a tight interpolation loop can drop or merge intermediate
    // positions (observed: the entity landed short of the drop point by
    // exactly the pixels consumed crossing CNCViewport's 5px drag-start
    // threshold). A short wait after each move lets each one land as its
    // own rendered pointermove before the next is dispatched -- the exact
    // path doesn't matter for this assertion, only that the FINAL move (to
    // dragTo) is individually processed before mouse.up().
    const STEPS = 8
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS
      await page.mouse.move(dragFrom.x + (dragTo.x - dragFrom.x) * t, dragFrom.y + (dragTo.y - dragFrom.y) * t)
      await page.waitForTimeout(30)
    }
    // Re-issue the exact final point once more before releasing -- the
    // interpolated move sequence consistently lands one step short (see
    // comment above); repeating the last coordinate flushes it to the
    // true drop point without depending on the exact step count.
    await page.mouse.move(dragTo.x, dragTo.y)
    await page.waitForTimeout(30)
    await page.mouse.up()
    const dragWallMs = Date.now() - dragT0 // WALL-CLOCK PROXY -- labeled, not a real solve-timing metric (none exists)

    sk = await waitForSolveSettled(page)
    const dragPointAfter = findEntity(sk, (e) => e.id === dragPoint.id)
    const dragGap = Math.hypot(dragPointAfter.at.x - 235, dragPointAfter.at.y - 35)
    assert(dragGap < 0.5, `dragged point expected near (235,35), got (${dragPointAfter.at.x.toFixed(2)}, ${dragPointAfter.at.y.toFixed(2)}), gap=${dragGap}`)

    await page.screenshot({ path: shot('05-drag-result.png') })
    console.log(`[sketch2d-smoke] wrote 05-drag-result.png (drag wall-clock proxy: ${dragWallMs}ms)`)

    baseline.flow4 = {
      dragFinalX: dragPointAfter.at.x, dragFinalY: dragPointAfter.at.y,
      dragWallClockMsProxyNotDeterministic: dragWallMs,
    }

    // ================= FLOW 5: downstream CAM-op geometry check ============
    console.log('[sketch2d-smoke] FLOW 5: bake sketch, read CAM-op loop area, edit sketch, re-bake, confirm it changed...')

    // `expectedArea` identifies the RECTANGLE's loop among the baked
    // "Sketches" geometry's several closed loops (rectangle + circle + the
    // flow-2 tangent circle) by nearest area match. It must be passed
    // freshly each call -- reusing the "before" target after editing the
    // rectangle would instead match the (unrelated, unchanged) circle once
    // the rectangle's own area moves further from the stale target than the
    // circle's does.
    async function readRectLoopArea(expectedArea) {
      await clickButton(page, 'Add operation (N)')
      await page.locator('.op-modal-tab').filter({ hasText: 'Geometry' }).click()
      const geoSelect = page.locator('[data-testid="op-geometry-select"]')
      const sketchesValue = await geoSelect.locator('option', { hasText: 'Sketches' }).getAttribute('value')
      assert(sketchesValue, 'no "Sketches" option in the op-geometry-select dropdown')
      await geoSelect.selectOption(sketchesValue)
      const result = await page.evaluate((target) => {
        const s = window.__camStore.getState()
        const geo = s.project.geometry.find((g) => g.name === 'Sketches')
        if (!geo) return null
        const closed = (geo.loops ?? []).filter((l) => l.closed)
        let bestIdx = -1, bestDelta = Infinity
        closed.forEach((l, i) => {
          const delta = Math.abs(Math.abs(l.area) - target)
          if (delta < bestDelta) { bestDelta = delta; bestIdx = i }
        })
        return { closedCount: closed.length, rectIdx: bestIdx, storeArea: closed[bestIdx] ? Math.abs(closed[bestIdx].area) : null }
      }, expectedArea)
      assert(result && result.rectIdx >= 0, 'no closed loops found on the baked Sketches geometry')
      const areaTexts = await page.locator('.op-loop-area').allTextContents()
      const domText = areaTexts[result.rectIdx]
      const domArea = parseFloat((domText.match(/[\d.]+/) ?? ['0'])[0])
      await page.locator('.modal-close-btn').first().click()
      return { storeArea: result.storeArea, domArea }
    }

    await clickButton(page, 'Finish sketch')
    await page.waitForSelector('.sketch-toolbox', { state: 'detached', timeout: 10_000 })

    // A blank project starts with zero Setups (project.setups: []) -- the
    // New Operation modal's "Add operation" button only exists per-Setup
    // row, so one must be created first (default stock is auto-derived,
    // per store.ts defaultSceneStock, so Create Setup needs no extra picks).
    await page.locator('[data-tooltip="Add setup"]').click()
    await page.getByRole('button', { name: 'Create Setup', exact: true }).click()

    const areaBefore = await readRectLoopArea(2400)
    console.log(`[sketch2d-smoke]   rect loop area before edit: store=${areaBefore.storeArea} dom~=${areaBefore.domArea}`)
    assert(approxEqual(areaBefore.storeArea, 2400, 5), `expected initial rect area ~2400mm^2, got ${areaBefore.storeArea}`)

    await page.locator('[data-tooltip="Edit sketch (parametric re-edit)"]').click()
    await page.waitForSelector('.sketch-toolbox', { timeout: 10_000 })
    await editDimension(page, dimD.id, 90)
    sk = await waitForSolveSettled(page)
    const line0After = findEntity(sk, (e) => e.id === line0.id)
    const line0Len = Math.hypot(line0After.end.x - line0After.start.x, line0After.end.y - line0After.start.y)
    assert(approxEqual(line0Len, 90, 0.1), `expected rect bottom-line length 90 after edit, got ${line0Len}`)

    await clickButton(page, 'Finish sketch')
    await page.waitForSelector('.sketch-toolbox', { state: 'detached', timeout: 10_000 })
    const areaAfter = await readRectLoopArea(3600)
    console.log(`[sketch2d-smoke]   rect loop area after edit: store=${areaAfter.storeArea} dom~=${areaAfter.domArea}`)
    // Width 60->90 with height pinned at 40 (DIM_E) -> area 2400 -> 3600, deterministically.
    assert(approxEqual(areaAfter.storeArea, 3600, 5),
      `expected rect loop area ~3600mm^2 after the sketch edit, got ${areaAfter.storeArea}`)
    assert(approxEqual(areaAfter.domArea, 3600, 5),
      `expected the CAM-op UI's own area readout to show ~3600mm^2, got ${areaAfter.domArea}`)

    await page.screenshot({ path: shot('06-cam-op-geometry.png') })
    console.log('[sketch2d-smoke] wrote 06-cam-op-geometry.png')

    baseline.flow5 = {
      rectLoopAreaBefore: areaBefore.storeArea,
      rectLoopAreaAfter: areaAfter.storeArea,
    }

    // ================= FLOW 6: run-local capture + golden gate =============
    console.log('[sketch2d-smoke] FLOW 6: run-local capture + golden gate...')
    const nonDeterministicKeys = ['dragWallClockMsProxyNotDeterministic']
    function stripNonDeterministic(obj) {
      const out = {}
      for (const [k, v] of Object.entries(obj)) {
        if (nonDeterministicKeys.includes(k)) continue
        out[k] = typeof v === 'object' && v !== null ? stripNonDeterministic(v) : v
      }
      return out
    }
    function flatten(obj, prefix = '', out = {}) {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k
        if (v && typeof v === 'object') flatten(v, key, out)
        else out[key] = v
      }
      return out
    }
    function getPath(obj, dotted) {
      return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
    }
    function setPath(obj, dotted, value) {
      const parts = dotted.split('.')
      let cur = obj
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]]
      cur[parts[parts.length - 1]] = value
    }

    // Per-field tolerance table (BK-90 fix 3). MEASURED 2026-07-10: 3
    // consecutive runs of this harness against unmodified main produced
    // BIT-IDENTICAL values for every field below (see
    // coordination/reports/INT-H6.report.json for the 3-run table) -- so
    // every tolerance is 0. If a future field legitimately jitters
    // run-to-run, widen ONLY that entry to (max observed spread across a
    // fresh 3-run measurement) x4, and document the measurement inline here
    // -- do not restore a blanket epsilon.
    const TOLERANCES = {
      'flow1.rectangleLine0Length': 0,
      'flow1.rectangleAngleDeg': 0,
      'flow1.circleDiameter': 0,
      'flow1.lineL1LengthAfterEdit': 0,
      'flow2.coincidentGap': 0,
      'flow2.horizontalDy': 0,
      'flow2.tangentResidual': 0,
      'flow2.dofAfterCoincident': 0,
      'flow2.dofAfterHorizontal': 0,
      'flow2.dofAfterTangent': 0,
      'flow3.referenceDimRejectedEditLength': 0,
      'flow3.drivingDimAppliedDiameter': 0,
      'flow4.dragFinalX': 0,
      'flow4.dragFinalY': 0,
      'flow5.rectLoopAreaBefore': 0,
      'flow5.rectLoopAreaAfter': 0,
    }

    // Negative-proof seam (BK-90 fix 4): an env var lets a caller perturb
    // one captured field before it's written/compared, to prove the gate
    // can actually fail and names the offending field. Never set in normal
    // runs -- SKETCH2D_SMOKE_PERTURB_FIELD is a dotted baseline path (e.g.
    // "flow5.rectLoopAreaAfter"), SKETCH2D_SMOKE_PERTURB_DELTA is optional
    // (defaults to 999).
    const perturbField = process.env.SKETCH2D_SMOKE_PERTURB_FIELD
    if (perturbField) {
      const perturbDelta = process.env.SKETCH2D_SMOKE_PERTURB_DELTA
        ? Number(process.env.SKETCH2D_SMOKE_PERTURB_DELTA) : 999
      const before = getPath(baseline, perturbField)
      assert(typeof before === 'number', `SKETCH2D_SMOKE_PERTURB_FIELD "${perturbField}" is not a known numeric baseline field`)
      setPath(baseline, perturbField, before + perturbDelta)
      console.log(`[sketch2d-smoke] *** NEGATIVE-PROOF PERTURBATION ACTIVE *** ${perturbField}: ${before} -> ${before + perturbDelta}`)
    }

    // Negative-proof seam (INT-H6-R1): a second env var lets a caller DELETE
    // one field from the run-local capture before it's written/compared, to
    // prove the golden gate also catches a field that vanished from the
    // current run while still present in the committed golden (the missing-
    // current direction the forward-only currentFlat loop could not see).
    // Never set in normal runs -- SKETCH2D_SMOKE_DROP_FIELD is a dotted
    // baseline path (e.g. "flow5.rectLoopAreaAfter").
    const dropField = process.env.SKETCH2D_SMOKE_DROP_FIELD
    if (dropField) {
      const before = getPath(baseline, dropField)
      assert(before !== undefined, `SKETCH2D_SMOKE_DROP_FIELD "${dropField}" is not a known baseline field`)
      const parts = dropField.split('.')
      let parent = baseline
      for (let i = 0; i < parts.length - 1; i++) parent = parent[parts[i]]
      delete parent[parts[parts.length - 1]]
      console.log(`[sketch2d-smoke] *** NEGATIVE-PROOF FIELD DROP ACTIVE *** ${dropField} deleted from run-local capture (was ${before})`)
    }

    // Negative-proof seam (INT-H6-R2): a third env var lets a caller replace
    // one field's value in the run-local capture with a non-numeric or
    // non-finite value, to prove the golden gate catches the fourth silent
    // path: a field present on both sides whose value is not a valid
    // measurement (NaN, a numeric string, null, etc). Never set in normal
    // runs -- SKETCH2D_SMOKE_INVALIDATE_FIELD is a dotted baseline path
    // (e.g. "flow5.rectLoopAreaAfter").
    const invalidateField = process.env.SKETCH2D_SMOKE_INVALIDATE_FIELD
    if (invalidateField) {
      const before = getPath(baseline, invalidateField)
      assert(before !== undefined, `SKETCH2D_SMOKE_INVALIDATE_FIELD "${invalidateField}" is not a known baseline field`)
      setPath(baseline, invalidateField, NaN)
      console.log(`[sketch2d-smoke] *** NEGATIVE-PROOF FIELD INVALIDATION ACTIVE *** ${invalidateField}: ${before} -> NaN`)
    }

    await writeFile(RUN_LOCAL_PATH, JSON.stringify(baseline, null, 2) + '\n')
    console.log(`[sketch2d-smoke] wrote run-local capture ${path.relative(REPO_ROOT, RUN_LOCAL_PATH)} (gitignored -- never the gate truth)`)

    if (REBASELINE) {
      if (existsSync(GOLDEN_PATH)) {
        const prior = JSON.parse(await readFile(GOLDEN_PATH, 'utf8'))
        const priorFlat = flatten(stripNonDeterministic(prior))
        const currentFlat = flatten(stripNonDeterministic(baseline))
        const changed = Object.keys(currentFlat).filter((k) => currentFlat[k] !== priorFlat[k])
        if (changed.length > 0) {
          console.log(`[sketch2d-smoke] --rebaseline: ${changed.length} field(s) differ from the currently committed golden:`)
          for (const k of changed) console.log(`    ${k}: ${priorFlat[k]} -> ${currentFlat[k]}`)
        } else {
          console.log('[sketch2d-smoke] --rebaseline: no field differs from the currently committed golden.')
        }
      }
      console.log(`[sketch2d-smoke] *** --rebaseline: OVERWRITING THE COMMITTED GATE TRUTH at ${path.relative(REPO_ROOT, GOLDEN_PATH)} -- this is the ONLY code path that does this. Review the diff above and commit deliberately. ***`)
      await writeFile(GOLDEN_PATH, JSON.stringify(baseline, null, 2) + '\n')
    } else {
      assert(existsSync(GOLDEN_PATH),
        `no committed golden at ${path.relative(REPO_ROOT, GOLDEN_PATH)} -- run with --rebaseline once to establish it`)
      const prior = JSON.parse(await readFile(GOLDEN_PATH, 'utf8'))
      const priorFlat = flatten(stripNonDeterministic(prior))
      const currentFlat = flatten(stripNonDeterministic(baseline))
      const mismatches = []
      // Compare the UNION of priorFlat and currentFlat keys (INT-H6-R1) --
      // iterating currentFlat alone only ever catches a NEW current field;
      // a field deleted from the run-local capture (still present in the
      // committed golden) would silently shrink the field count and pass.
      const allFields = new Set([...Object.keys(priorFlat), ...Object.keys(currentFlat)])
      for (const field of allFields) {
        const curVal = currentFlat[field]
        const priorVal = priorFlat[field]
        if (curVal === undefined) {
          mismatches.push(`${field}: MISSING FIELD, present in the committed golden but absent from the run-local capture (prior=${priorVal})`)
          continue
        }
        if (priorVal === undefined) {
          mismatches.push(`${field}: NEW FIELD, not present in the committed golden (current=${curVal})`)
          continue
        }
        // INT-H6-R2: both sides must be a genuine finite number before
        // subtraction -- otherwise NaN arithmetic (delta = NaN, NaN > eps is
        // false) or JS coercion (numeric string / null == number) makes the
        // gate silently PASS on a non-measurement value.
        const priorValid = typeof priorVal === 'number' && Number.isFinite(priorVal)
        const curValid = typeof curVal === 'number' && Number.isFinite(curVal)
        if (!priorValid || !curValid) {
          mismatches.push(`${field}: INVALID NUMERIC FIELD (prior=${numRepr(priorVal)} current=${numRepr(curVal)})`)
          continue
        }
        const eps = TOLERANCES[field]
        assert(eps !== undefined, `no TOLERANCES entry for field "${field}" -- add one (measured, not guessed) before this can gate`)
        const delta = Math.abs(curVal - priorVal)
        if (delta > eps) mismatches.push(`${field}: prior=${priorVal} current=${curVal} delta=${delta} tolerance=${eps}`)
      }
      if (mismatches.length > 0) {
        throw new Error(
          `GOLDEN GATE FAILED -- ${mismatches.length} field(s) drifted beyond tolerance vs the committed golden ` +
          `(${path.relative(REPO_ROOT, GOLDEN_PATH)}):\n  ${mismatches.join('\n  ')}`,
        )
      }
      console.log(`[sketch2d-smoke] GOLDEN GATE PASSED: all ${Object.keys(currentFlat).length} fields within tolerance vs the committed golden.`)
    }

    // Flow 6's own end state: the final app view (post-bake, all flows'
    // geometry + Setup/Operation present) at the moment the golden baseline
    // was captured/compared -- every flow gets at least one screenshot.
    await page.screenshot({ path: shot('07-baseline-captured.png') })
    console.log('[sketch2d-smoke] wrote 07-baseline-captured.png')

    if (pageErrors.length > 0) {
      console.log(`[sketch2d-smoke] FAIL: ${pageErrors.length} page/console error(s):`)
      for (const e of pageErrors.slice(0, 20)) console.log(`  ${e}`)
      process.exitCode = 1
      return
    }

    console.log(`\nPASS: 2D CAM sketcher real-app smoke completed (6 flows, 7 screenshots, ${REBASELINE ? 'golden re-baselined' : 'golden gate passed'}).`)
  } catch (err) {
    console.error('[sketch2d-smoke] FAIL:', err)
    console.error('--- dev server output (tail) ---')
    console.error(serverOutput.slice(-4000))
    process.exitCode = 1
  } finally {
    if (browser !== undefined) await browser.close()
    killTree(server.pid)
  }
}

main()
