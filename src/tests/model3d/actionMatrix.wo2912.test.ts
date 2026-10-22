// @vitest-environment jsdom
// Extend WO-2819, rather than introduce a second set of command implementations.
// Scene rays and download/cache I/O are deterministic; all mutations go through
// the production Model UI or the production project Save/Open actions.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { actionAudit as runner, configureActionAudit, type Outcome } from './directEditAuditWave3.wo2819.test'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { useCamStore } from '../../store'

type Verdict = 'WORKS' | 'REFUSES' | 'BROKEN'
interface Stage { verdict: Verdict; message: string; witness?: unknown }
interface Cell {
  inputs: Array<{ path: string; sha256: string }>
  entity: string | null
  placement: 'original fixture coordinates (mm)'
  stages: Record<string, Stage>
}
// jsdom has no object-URL lifecycle; the product revokes URLs on a later task.
URL.revokeObjectURL ??= () => {}

const evidenceRoot = resolve('src/tests/evidence/WO-2912')
const negativeControl = process.env.WO2912_BREAK_FILLET === '1'
const directory = negativeControl ? resolve(evidenceRoot, 'negative-control') : process.env.WO2912_RAIL_PROBE === '1' ? resolve(evidenceRoot, 'rail-probe') : evidenceRoot
mkdirSync(directory, { recursive: true })
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const matrix: Record<string, Cell> = {}
const discovering = process.env.WO2912_DISCOVER === '1'
const baseline: Record<string, Record<string, Verdict>> = discovering ? {} : JSON.parse(readFileSync(resolve(evidenceRoot, 'baseline.json'), 'utf8'))
const reds: string[] = []
const hooks = runner.hooks
const payload = (id: string) => JSON.parse(JSON.stringify(hooks().dag.getNode(id)?.payload ?? null))
const change = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } })
const uiText = () => [...document.querySelectorAll('[data-testid]')]
  .filter((e) => /error|refusal|notice|hint|status-line/.test(e.getAttribute('data-testid') ?? ''))
  .map((e) => e.textContent).filter(Boolean).join(' | ')

async function settled(id: string): Promise<void> {
  await waitFor(() => {
    expect(hooks().dag.getNode(id), id).toBeDefined()
    expect(hooks().scheduler.statusOf(id), `${id}: ${uiText()}`).toBe('ok')
  }, { timeout: 30_000 })
}

async function measure(id: string): Promise<unknown> {
  if (hooks().getBodyHandle(id) === undefined) return payload(id)
  const mesh = await hooks().client.tessellate(hooks().getBodyHandle(id)!, { deflection: 0.05 })
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.position.length; i++) {
    const axis = i % 3
    bounds[axis] = Math.min(bounds[axis], mesh.position[i])
    bounds[axis + 3] = Math.max(bounds[axis + 3], mesh.position[i])
  }
  return { volume: await runner.volumeOf(id), bounds }
}

function sameGeometry(actual: unknown, expected: unknown): void {
  const a = actual as { volume?: number; bounds?: number[] }
  const b = expected as typeof a
  if (typeof b.volume === 'number') {
    // Replay must reproduce the same kernel result, well inside fixture tolerances.
    expect(a.volume).toBeCloseTo(b.volume, 3)
    a.bounds!.forEach((v, i) => expect(v).toBeCloseTo(b.bounds![i], 3))
  } else expect(actual).toEqual(expected)
}

async function captureSave(): Promise<string> {
  const blobs: Blob[] = []
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL
  URL.createObjectURL = (blob) => { blobs.push(blob as Blob); return 'blob:wo2912-project' }
  URL.revokeObjectURL = () => {}
  const anchorClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = () => {}
  try {
    let result: unknown
    await act(async () => { result = await useCamStore.getState().saveProjectToFile() })
    expect(result, uiText()).toBe('saved')
    expect(blobs).toHaveLength(1)
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsText(blobs[0])
    })
  } finally {
    HTMLAnchorElement.prototype.click = anchorClick; URL.createObjectURL = create; URL.revokeObjectURL = revoke
  }
}

async function reopen(saved: string): Promise<void> {
  runner.unmount()
  runner.clearCaches()
  // Clear the live document through New, then use the exact downloaded file.
  // The cache mocks implement the same I/O contracts as the original runner.
  await act(async () => { useCamStore.getState().newProject(); await useCamStore.getState().loadProjectFromFile(saved) })
  runner.remount()
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
}

async function edit(id: string): Promise<unknown> {
  const before = payload(id)
  const beforeGeometry = await measure(id) as { volume?: number; bounds?: number[] }
  const node = hooks().dag.getNode(id)!
  // Form and Relief intentionally expose Edit through the tree, while the
  // toolbar resolver still omits them. Exercise the offered route itself.
  fireEvent.contextMenu(screen.getByTestId(`feature-row-${id}`))
  const button = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
  expect(button.disabled, button.title).toBe(false)
  fireEvent.click(button)
  const op = node.payload.opType
  if (node.kind === 'sketch') {
    await waitFor(() => expect(screen.queryByTestId('workbench-package-tool-project')).not.toBeNull())
    fireEvent.click(screen.getByTestId('workbench-package-tool-project'))
    const canvas = screen.getByTestId('solids-workbench-canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    for (const type of ['pointerMove', 'pointerDown', 'pointerUp', 'click'] as const) fireEvent[type](canvas, { clientX: 400, clientY: 300, button: 0 })
    await waitFor(() => expect(payload(id)).not.toEqual(before), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull())
  } else if (op === 'pushPull') {
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry-input')).not.toBeNull())
    const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: String(Number(input.value) + 1) } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      const gesture = hooks().getPushPullTransactionState().gesture
      expect(!gesture.inFlight && gesture.previewHandle !== null).toBe(true)
    }, { timeout: 30_000 })
    fireEvent.keyDown(screen.getByTestId('pushpull-delta-entry-input'), { key: 'Enter' })
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry-input')).toBeNull(), { timeout: 30_000 })
  } else if (op === 'resizeHole') {
    await waitFor(() => expect(screen.queryByTestId('move-hole-x') ?? screen.queryByTestId('resize-hole-anchor-entry-input')).not.toBeNull())
    if (screen.queryByTestId('move-hole-x')) {
      change('move-hole-x', '3')
      await waitFor(() => expect(screen.getByTestId('move-hole-status').getAttribute('data-status')).toBe('ready'), { timeout: 30_000 })
      fireEvent.click(screen.getByTestId('move-hole-apply'))
    } else {
      change('resize-hole-anchor-entry-input', '7')
      await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').getAttribute('data-status')).toBe('ready'), { timeout: 30_000 })
      fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    }
  } else if (op === 'form') {
    await waitFor(() => expect(screen.queryByTestId('form-select-all')).not.toBeNull())
    fireEvent.click(screen.getByTestId('form-select-all'))
    fireEvent.click(screen.getByTestId('form-transform-rotate'))
    fireEvent.change(screen.getByLabelText('Centre rotation axis'), { target: { value: 'z' } })
    runner.commitLabel('Rotation angle', '15')
    fireEvent.click(screen.getByTestId('form-rotation-apply'))
    fireEvent.click(screen.getByTestId('form-finish'))
  } else if (op === 'relief') {
    await waitFor(() => expect(screen.queryByTestId('relief-depth-slider')).not.toBeNull())
    const input = screen.getByTestId('relief-depth-slider') as HTMLInputElement
    fireEvent.change(input, { target: { value: String(Number(input.value) + 0.5) } })
    await waitFor(() => expect((screen.getByTestId('relief-apply') as HTMLButtonElement).disabled).toBe(false), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('relief-apply'))
  } else {
    await waitFor(() => expect(screen.queryByTestId('dialog-shell-apply')).not.toBeNull())
    if (op === 'fillet' || op === 'chamfer') {
      runner.commitField(op === 'fillet' ? 'fillet-radius' : 'chamfer-distance', '1.2')
    } else if (op === 'boolean') {
      change('boolean-op-select', node.payload.boolOp === 'intersect' ? 'fuse' : 'intersect')
    } else if (op === 'shell' || op === 'draft') {
      runner.commitField(op === 'shell' ? 'shell-thickness' : 'draft-angle', op === 'shell' ? '0.6' : '3')
    } else if (op === 'defeature') {
      // Edit the stored mask using another actual offered removable group.
      const choices = [...document.querySelectorAll<HTMLInputElement>('input[data-testid^="defeature-check-"]')].filter((e) => !e.disabled)
      const extra = choices.find((e) => !e.checked)
      expect(extra, 'another removable face group').toBeDefined()
      fireEvent.click(extra!)
    } else if (op === 'hole') {
      runner.commitField('hole-diameter', '6')
    } else {
      // Datums with picked references deliberately preserve their picks during
      // Edit; flip normal/direction where offered, otherwise change the name.
      const flip = screen.queryByTestId('offset-plane-flip-normal') ?? screen.queryByTestId('axis-flip') ?? screen.queryByTestId('picked-plane-flip')
      if (flip) fireEvent.click(flip)
      else {
        const name = screen.getByTestId(node.payload.datumType === 'point' ? 'point-datum-name' : 'picked-plane-name') as HTMLInputElement
        expect(name, 'datum name field').toBeDefined()
        fireEvent.change(name!, { target: { value: name!.value + ' edited' } })
      }
    }
    await waitFor(() => expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled, uiText()).toBe(false), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.queryByTestId('dialog-shell')).toBeNull(), { timeout: 30_000 })
  }
  await waitFor(() => expect(payload(id), 'Edit must rewrite the SAME node').not.toEqual(before), { timeout: 30_000 })
  await settled(id)
  const geometry = await measure(id) as typeof beforeGeometry
  if (typeof geometry.volume === 'number' && ['fillet', 'chamfer', 'shell', 'draft', 'hole', 'pushPull'].includes(String(op))) {
    expect(Math.abs(geometry.volume - beforeGeometry.volume!), 'edited driving value must change material').toBeGreaterThan(0.05)
  }
  if (op === 'form') expect(Math.max(...geometry.bounds!.map((v, i) => Math.abs(v - beforeGeometry.bounds![i]))), '15 degree cage edit must change the imported part bounds').toBeGreaterThan(0.01)
  return { before, after: payload(id), geometry }
}

async function stage(cell: string, name: string, run: () => Promise<unknown>): Promise<boolean> {
  console.log(`WO-2912 STAGE ${cell} ${name} started`)
  try {
    const witness = await run()
    const raw = JSON.stringify(witness)
    const compact = raw && raw.length > 4000 ? { bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') } : witness
    matrix[cell].stages[name] = { verdict: 'WORKS', message: 'production route verified', witness: compact }
    console.log(`WO-2912 STAGE ${cell} ${name} WORKS`)
    return true
  } catch (error) {
    const message = String(error).slice(0, 1800)
    matrix[cell].stages[name] = { verdict: 'BROKEN', message, witness: uiText() }
    console.log(`WO-2912 STAGE ${cell} ${name} BROKEN ${message.slice(0, 300)}`)
    reds.push('RED: ' + JSON.stringify({ id: `actionMatrix.wo2912.test.ts::${cell}::${name}`, class: 'unresolved', owner: 'WO-2912 discovery; architect triage', evidence: `src/tests/evidence/WO-2912/matrix.json#${cell}/${name}`, nextAction: 'Review this production-route failure before granting a product fix' }))
    return false
  }
}

async function recordLifecycle(cell: string, outcome: Outcome): Promise<void> {
  const id = typeof outcome.detail.id === 'string' ? outcome.detail.id : hooks().dag.featureOrder().at(-1) ?? null
  matrix[cell] = {
    inputs: [...runner.fixtureInputs].map((path) => ({ path: relative(process.cwd(), path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })),
    entity: id, placement: 'original fixture coordinates (mm)',
    stages: { apply: { verdict: outcome.verdict === 'WORKS' ? 'WORKS' : outcome.verdict === 'REFUSES' ? 'REFUSES' : 'BROKEN', message: outcome.message, witness: { ...outcome.detail, operatorText: outcome.verdict === 'REFUSES' ? { rendered: uiText(), console: runner.consoleLines.slice(-2) } : undefined } } },
  }
  if (matrix[cell].stages.apply.verdict === 'BROKEN') reds.push('RED: ' + JSON.stringify({ id: `actionMatrix.wo2912.test.ts::${cell}::apply`, class: 'unresolved', owner: 'WO-2912 discovery; architect triage', evidence: `src/tests/evidence/WO-2912/matrix.json#${cell}/apply`, nextAction: 'Review the geometry mismatch before granting a product fix' }))
  const documentCommand = /EXPORT|DEBUG/.test(cell)
  if (outcome.verdict !== 'WORKS' || id === null) {
    // Refused/unoffered commands have no mutation to edit or undo; record the
    // actual apply text instead of inventing an operator-facing lifecycle.
    return
  }
  const originalPayload = payload(id)
  const originalGeometry = await measure(id)
  let saved = ''
  const savedOk = await stage(cell, 'recovery-save', async () => {
    saved = await captureSave()
    return { bytes: saved.length, sha256: createHash('sha256').update(saved).digest('hex') }
  })
  let editedPayload: unknown
  const editOk = !documentCommand && await stage(cell, 'edit', async () => {
    const result = await edit(id)
    editedPayload = payload(id)
    return result
  })
  if (editOk) {
    await stage(cell, 'undo-edit', async () => {
      fireEvent.click(screen.getByTestId('workbench-undo'))
      await waitFor(() => expect(payload(id)).toEqual(originalPayload), { timeout: 30_000 })
      await settled(id); sameGeometry(await measure(id), originalGeometry)
      return originalPayload
    })
    await stage(cell, 'redo-edit', async () => {
      fireEvent.click(screen.getByTestId('workbench-redo'))
      await waitFor(() => expect(payload(id)).toEqual(editedPayload), { timeout: 30_000 })
      await settled(id)
      return editedPayload
    })
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(payload(id)).toEqual(originalPayload), { timeout: 30_000 })
    await settled(id)
  }
  if (editOk) {
    // From-body Finish also records hiding its source. Undo every entry
    // belonging to the applied feature, retaining the actual step count.
    let undoSteps = 0
    await stage(cell, 'undo-apply', async () => {
      while (hooks().dag.getNode(id) !== undefined && undoSteps < 4) {
        const historyBefore = hooks().history.serialize()
        fireEvent.click(screen.getByTestId('workbench-undo'))
        await waitFor(() => expect(hooks().history.serialize()).not.toEqual(historyBefore), { timeout: 30_000 })
        undoSteps++
        if (hooks().dag.getNode(id) !== undefined) await settled(id)
      }
      expect(hooks().dag.getNode(id)).toBeUndefined()
      return { absent: id, undoSteps }
    })
    await stage(cell, 'redo-apply', async () => {
      for (let step = 0; step < undoSteps; step++) {
        const historyBefore = hooks().history.serialize()
        fireEvent.click(screen.getByTestId('workbench-redo'))
        await waitFor(() => expect(hooks().history.serialize()).not.toEqual(historyBefore), { timeout: 30_000 })
        if (hooks().dag.getNode(id) !== undefined) await settled(id)
      }
      await settled(id); expect(payload(id)).toEqual(originalPayload)
      sameGeometry(await measure(id), originalGeometry)
      return { geometry: await measure(id), redoSteps: undoSteps }
    })
  }
  if (editOk || documentCommand) await stage(cell, 'save', async () => {
    saved = await captureSave()
    return { bytes: saved.length, sha256: createHash('sha256').update(saved).digest('hex') }
  })
  if (savedOk) await stage(cell, 'reopen', async () => {
    await reopen(saved); await settled(id)
    expect(payload(id)).toEqual(originalPayload)
    sameGeometry(await measure(id), originalGeometry)
    return { payload: payload(id), geometry: await measure(id) }
  })
}
configureActionAudit({ label: 'WO-2912', evidenceDir: relative(process.cwd(), directory), onRecord: recordLifecycle,
  wrapClient: (client) => {
    // Inject only at the real service boundary: the UI asks for 1 mm, but
    // the kernel receives 0.5 mm. All imports, picks and other methods stay real.
    if (negativeControl) {
      const fillet = client.applyFillet.bind(client)
      client.applyFillet = (request) => fillet({ ...request, radius: 0.5 })
    }
    return client
  },
})

for (const format of ['STEP', 'STL'] as const) {
  for (const tool of ['shell', 'draft', 'hole', 'resize-hole', 'move-hole', 'defeature'] as const) {
    it(`${format}-RAIL-${tool}: apply on a real imported part and exercise its lifecycle`, async () => {
      const fixture = format === 'STEP' && /resize|move|defeature/.test(tool) ? 'stepped_holes' : 'rib_part'
      const session = format === 'STEP'
        ? await runner.openStep(resolve('src/tests/evidence/WO-2757', fixture + '.step'))
        : await runner.openPrismaticStl(fixture)
      const bodyId = hooks().dag.featureOrder().find((id) => hooks().getBodyHandle(id) !== undefined)!
      const before = hooks().dag.featureOrder()
      const faces = await runner.facesOf(bodyId)
      fireEvent.click(screen.getByTestId(`workbench-${tool}`))
      let outcome: Outcome
      if (tool === 'resize-hole' || tool === 'move-hole') {
        await waitFor(() => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i))
        const hint = screen.getByTestId('solids-workbench-resizehole-hint')
        if (hint.className.includes('refusal')) {
          expect(hooks().dag.featureOrder()).toEqual(before)
          await recordLifecycle(`${format}-RAIL-${tool}`, { verdict: 'REFUSES', message: hint.textContent ?? '', detail: { fixture, check: 'unperforated imported rib has no recognized holes; no feature authored' } })
          return
        }
        const wall = runner.findFace(faces, '5 mm through-hole at x55', (face) => face.type === 'cylinder' && Math.abs(face.centroid.x - 55) < 0.1)
        runner.aimAtFace(session.runtime, wall); runner.click()
        const moving = tool === 'move-hole'
        await waitFor(() => expect(screen.queryByTestId(moving ? 'move-hole-x' : 'resize-hole-anchor-entry-input')).not.toBeNull())
        if (moving) change('move-hole-x', '2')
        else change('resize-hole-anchor-entry-input', '6')
        const status = moving ? 'move-hole-status' : 'resize-hole-anchor-entry-status'
        await waitFor(() => expect(['ready', 'refused']).toContain(screen.getByTestId(status).getAttribute('data-status')), { timeout: 30_000 })
        if (screen.getByTestId(status).getAttribute('data-status') !== 'ready') {
          outcome = { verdict: 'REFUSES', message: screen.getByTestId(status).textContent ?? '', detail: { check: 'picked cylindrical wall at x55, diameter5, full height15' } }
        } else {
          fireEvent.click(screen.getByTestId(moving ? 'move-hole-apply' : 'resize-hole-anchor-entry-apply'))
          outcome = await runner.judgeApplied(before, session.volume, moving ? 0 : -15 * Math.PI * (9 - 6.25))
          if (outcome.verdict === 'WORKS') {
            const resultFaces = await runner.facesOf(String(outcome.detail.id))
            const hole = runner.findFace(resultFaces, moving ? 'moved hole centre x57' : 'resized hole centre x55', (f) => f.type === 'cylinder' && Math.abs(f.centroid.x - (moving ? 57 : 55)) < 0.1)
            expect(hole.max.x - hole.min.x).toBeCloseTo(moving ? 5 : 6, 1)
          }
        }
      } else if (tool === 'defeature') {
        await waitFor(() => expect(screen.queryByTestId('defeature-picker')).not.toBeNull())
        const checks = [...document.querySelectorAll<HTMLInputElement>('input[data-testid^="defeature-check-"]')].filter((e) => !e.disabled)
        if (checks.length === 0) {
          const message = screen.getByTestId('defeature-empty').textContent ?? ''
          expect(hooks().dag.featureOrder()).toEqual(before)
          await recordLifecycle(`${format}-RAIL-${tool}`, { verdict: 'REFUSES', message, detail: { fixture, check: 'no offered removable group; no feature authored' } })
          return
        }
        let selected = checks[0]
        if (fixture === 'stepped_holes') {
          const wall = runner.findFace(faces, '5 mm through-hole at x55', (f) => f.type === 'cylinder' && Math.abs(f.centroid.x - 55) < 0.1)
          const groups = await hooks().client.recognizeFeatures(hooks().getBodyHandle(bodyId)!)
          const group = groups.find((g) => g.removable && g.featureClass === 'throughHole' && g.faceIds.includes(wall.id))
          expect(group, 'removable 5 mm through-hole').toBeDefined()
          selected = screen.getByTestId(`defeature-check-${group!.featureKey}`) as HTMLInputElement
        }
        fireEvent.click(selected)
        await waitFor(() => expect(['ready', 'failed', 'refused']).toContain(screen.getByTestId('defeature-preview-status').getAttribute('data-state')), { timeout: 30_000 })
        if ((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled) {
          outcome = { verdict: 'REFUSES', message: screen.getByTestId('defeature-preview-status').textContent ?? '', detail: { check: 'first offered removable group on real stepped-hole plate' } }
        } else {
          fireEvent.click(screen.getByTestId('dialog-shell-apply'))
          outcome = await runner.judgeApplied(before, session.volume, fixture === 'rib_part' ? -50 * 3 * 15 : Math.PI * 2.5 ** 2 * 15)
        }
      } else {
        const face = runner.findFace(faces, tool === 'draft' ? 'bottom neutral plane' : 'base top plane', (f) => f.type === 'plane' && (tool === 'draft' ? f.normal.z < -0.99 : f.normal.z > 0.99 && Math.abs(f.centroid.z - 5) < 0.01))
        runner.aimAtFace(session.runtime, face); runner.click()
        if (tool === 'shell') runner.commitField('shell-thickness', '0.5')
        if (tool === 'hole') {
          await waitFor(() => expect(screen.queryByTestId('hole-diameter')).not.toBeNull())
          runner.commitField('hole-diameter', '5'); runner.commitField('hole-blind-distance', '3')
        }
        if (tool === 'draft') {
          await waitFor(() => expect(screen.queryByTestId('draft-confirm-neutral')).not.toBeNull())
          fireEvent.click(screen.getByTestId('draft-confirm-neutral'))
          const side = runner.findFace(faces, 'outer plate side at x0', (f) => f.type === 'plane' && f.normal.x < -0.99 && Math.abs(f.centroid.x) < 0.01)
          runner.aimAtFace(session.runtime, side); runner.click()
          runner.commitField('draft-angle', '2')
        }
        outcome = await runner.previewThenApply(tool, session, before, tool === 'hole' ? -Math.PI * 2.5 ** 2 * 3 : null)
        if (outcome.verdict === 'WORKS' && tool === 'shell') expect(Number(outcome.detail.volumeDelta)).toBeLessThan(0)
        if (outcome.verdict === 'WORKS' && tool === 'draft') expect(Math.abs(Number(outcome.detail.volumeDelta))).toBeCloseTo(0.5 * 5 ** 2 * 40 * Math.tan(2 * Math.PI / 180), 1)
      }
      await recordLifecycle(`${format}-RAIL-${tool}`, { ...outcome, detail: { ...outcome.detail, check: 'real imported part; production pick/preview/apply; analytic diameter/move/hole/draft and material-sign checks', fixture } })
    }, 180_000)
  }
  it(`${format}-NEW-SKETCH: start on the imported face, edit with Project, undo and reopen`, async () => {
    const session = format === 'STEP' ? await runner.openStep(resolve('src/tests/evidence/WO-2757/rib_part.step')) : await runner.openPrismaticStl()
    const body = hooks().dag.featureOrder().find((id) => hooks().getBodyHandle(id) !== undefined)!
    const face = runner.findFace(await runner.facesOf(body), 'rib base top', (f) => f.type === 'plane' && f.normal.z > 0.99 && Math.abs(f.centroid.z - 5) < 0.01)
    runner.aimAtFace(session.runtime, face); runner.click()
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-finish-package-sketch')).not.toBeNull())
    const id = hooks().dag.nodeIds().find((id) => id.startsWith('sketch3d:'))!
    expect(id).toBeDefined()
    expect((payload(id).sketch as { entities: unknown[] }).entities).toHaveLength(0)
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull())
    await recordLifecycle(`${format}-NEW-SKETCH`, { verdict: 'WORKS', message: 'blank sketch started on the imported planar face and finished', detail: { id, check: 'face-bound blank-by-default sketch; Edit explicitly projects its source boundary', face: face.id, aim: face.aim } })
  }, 180_000)
  it(`${format}-SKETCH-CONTEXT: sketch-only solid commands are disabled without sketches`, async () => {
    if (format === 'STEP') await runner.openStep(resolve('src/tests/evidence/WO-2757/rib_part.step'))
    else await runner.openPrismaticStl()
    for (const tool of ['extrude', 'revolve', 'sweep', 'loft']) {
      const button = screen.getByTestId(`workbench-${tool}`) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      const before = hooks().dag.serialize()
      fireEvent.click(button)
      expect(hooks().dag.serialize()).toBe(before)
      await recordLifecycle(`${format}-SKETCH-${tool}`, { verdict: 'REFUSES', message: button.title || button.textContent || '', detail: { offered: true, disabled: true, context: 'imported solid without a sketch; no operator refusal text is rendered', check: 'disabled button authors no feature' } })
    }
  }, 180_000)
}

afterAll(() => {
  // afterAll hooks unwind in reverse order; consume the live runner records,
  // never the previous run's cells.json.
  const inventory = runner.cells.INVENTORY?.detail as { model: Array<{ id: string }>; form: Array<{ id: string }> } | undefined
  if (inventory) {
    const ids = Object.fromEntries((['model', 'form'] as const).map((rail) => [rail, inventory[rail].map((button: { id: string }) => button.id)]))
    if (discovering) writeFileSync(resolve(directory, 'inventory.json'), JSON.stringify(ids, null, 2) + '\n')
    else if (!negativeControl) expect(ids, 'a changed rail needs an explicit matrix coverage decision').toEqual(JSON.parse(readFileSync(resolve(evidenceRoot, 'inventory.json'), 'utf8')))
  }
  const verdicts = Object.fromEntries(Object.entries(matrix).map(([cell, value]) => [cell, Object.fromEntries(Object.entries(value.stages).map(([name, stage]) => [name, stage.verdict]))]))
  writeFileSync(resolve(directory, 'matrix.json'), JSON.stringify({ source, route: 'WO-2819 production Model actions + tree Edit + Undo/Redo + saveProjectToFile/loadProjectFromFile', cells: matrix }, null, 2) + '\n')
  writeFileSync(resolve(directory, 'reds.jsonl'), reds.join('\n') + (reds.length ? '\n' : ''))
  if (discovering) writeFileSync(resolve(directory, 'baseline.json'), JSON.stringify(verdicts, null, 2) + '\n')
  else if (!negativeControl) expect(verdicts, 'WORKS cells must never be downgraded; baseline changes need reviewed evidence').toEqual(baseline)
})
