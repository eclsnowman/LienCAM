// WO-2710 gap steps outside Control: CAM toolpath views (T-2, T-3, 3-1..3-3),
// Tool Library probe (T-1), Settings > User Data (S-1), Sketch reference
// image calibration (K-1), Model revolve/sweep/loft (M-1) and the first-start
// example picker (H-2, demo build). Real UI only; see p2.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { EVIDENCE } from './p2-lib.mjs'

/** Wait until every operation has finished computing (console strip reads Ready). */
async function waitCompute(h, timeout = 600_000) {
  await h.page.waitForFunction(() => /Ready\s*\(\s*\d+\s+operations?\s*\)/.test(document.body.innerText), null, { timeout })
  await h.page.waitForTimeout(1000)
}

const VIEWPORT_BOX = { x: 284, y: 46, width: 1372, height: 932 }

/**
 * Open a shipped example, compute it (REGEN ALL), select one operation on the
 * Toolpath tab so the view shows only its path, zoom the view onto the part,
 * shoot; then open the operation's Passes tab and shoot the dialog.
 */
async function camOperation(h, { gap, project, op, file, zoom = 3, zoomAt = { x: 970, y: 520 }, passes = true, appState, reuse = false }) {
  const { page } = h
  if (!reuse) {
    await h.chooseStarterMachine()
    await h.openProject(project)
    await page.getByTestId('mode-tab-toolpath').click()
    await page.waitForTimeout(1000)
    await page.locator('.tree-section-regen-btn').click()
    await page.waitForTimeout(2000)
    await waitCompute(h)
  }
  const row = page.locator('.tree-op-label', { hasText: op }).first()
  await row.click()
  await page.waitForTimeout(1200)
  await page.mouse.move(zoomAt.x, zoomAt.y)
  for (let i = 0; i < zoom; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(250) }
  await page.waitForTimeout(1500)
  const opName = (await row.innerText()).trim()
  const status = await page.locator('body').innerText()
  if (!/Status\s+ready/i.test(status)) throw new Error(`${gap}: ${opName} is not ready`)
  const full = `${file}-toolpath.png`
  await h.shot(full)
  h.sidecar(full, { appState: `${appState} Toolpath computation finished; "${opName}" selected on the Toolpath tab in the design tree, so the view shows its path and the Properties panel its summary; the view zoomed ${zoom} wheel steps toward the part. Whole frame.` })
  const view = `${file}-view.png`
  await h.crop(full, view, VIEWPORT_BOX)
  h.sidecar(view, { appState: `${full} cropped to the 3D view.`, crop: VIEWPORT_BOX, wholeFrame: full })
  if (passes) {
    await row.dblclick()
    await page.locator('.op-modal-tab', { hasText: /^Passes$/ }).first().click()
    await page.waitForTimeout(1000)
    const dlg = `${file}-passes.png`
    await h.shot(dlg)
    const box = await h.box(page.locator('.modal-container').first())
    h.sidecar(dlg, { appState: `Same session: "${opName}" opened for editing (double-click), Passes tab. Whole frame.` })
    const crop = `${file}-passes-dialog.png`
    await h.crop(dlg, crop, box)
    h.sidecar(crop, { appState: `${dlg} cropped to the Edit Operation dialog.`, crop: box, wholeFrame: dlg })
    await page.getByRole('button', { name: /^Cancel$/ }).first().click()
  }
}

export const CAM_GAPS = {
  // T-2 - Engraving: a new Engrave operation over the name-sign lettering (no shipped example has one).
  'T-2': {
    async run(h) {
      const { page } = h
      const tab = (label) => page.locator('.op-modal-tab', { hasText: new RegExp(`^${label}$`) }).first()
      await h.chooseStarterMachine()
      await h.openProject('examples/05-name-sign/name-sign.camproject')
      await page.getByTestId('mode-tab-toolpath').click()
      await page.waitForTimeout(800)
      await page.getByRole('button', { name: /^Add operation/ }).first().click()
      await page.locator('.op-modal-tab').first().waitFor()
      await page.locator('.op-type-card', { has: page.locator('.op-type-name', { hasText: /^Engrave \/ Trace$/ }) }).first().click()
      await page.waitForTimeout(500)
      await tab('Tool').click()
      await page.locator('.op-tool-row', { hasText: '6 mm 60 deg V-bit' }).click()
      await tab('Geometry').click()
      const source = page.locator('[data-testid="op-modal-panel"] select').filter({ has: page.locator('option', { hasText: 'lettering (8 closed loops)' }) })
      await source.selectOption({ label: 'lettering (8 closed loops)' })
      await page.getByRole('button', { name: /^All loops/ }).click()
      await tab('Passes').click()
      await page.getByRole('button', { name: /^Depth from line width/ }).click()
      await tab('Heights').click()
      await h.debug('configured-heights')
      await page.getByTestId('op-create').click()
      await page.getByTestId('op-modal-panel').waitFor({ state: 'detached' })
      await waitCompute(h, 60_000)
      await camOperation(h, { gap: 'T-2', op: /Engrave/, file: 'T-2-engrave', zoom: 3, reuse: true,
        appState: 'Name-sign example; Engrave / Trace added over lettering, 6 mm 60 deg V-bit, depth from line width enabled. Operation created and computed through the UI.' })
    },
  },

  // M-1: construct native profiles through the production Model workspace.
  'M-1': {
    async run(h) {
      const { page, tid } = h
      const orbit = async (reverse = false) => {
        await page.mouse.move(reverse ? 1120 : 940, reverse ? 620 : 500)
        await page.mouse.down({ button: 'middle' })
        await page.mouse.move(reverse ? 940 : 1120, reverse ? 500 : 620, { steps: 16 })
        await page.mouse.up({ button: 'middle' })
        await page.waitForTimeout(1000)
      }
      const shootResult = async (feature) => {
        const glyphs = page.locator('[data-testid^="genesis-visible-"][aria-label="Hide in viewport"]')
        const glyphIds = await glyphs.evaluateAll(elements => elements.map(el => el.getAttribute('data-testid')))
        for (const id of glyphIds) await tid(id).click()
        await orbit()
        const file = `M-1-${feature}-result.png`
        await h.shot(file)
        h.sidecar(file, { appState: `Native Model workspace: ${feature} constructed from real UI sketches and Apply; one solid body, feature tree and body volume visible. Camera orbited with the mouse. Whole frame. The three result frames are separate stages of the same session, not three simultaneous bodies.` })
        await h.crop(file, `M-1-${feature}-view.png`, VIEWPORT_BOX)
        h.sidecar(`M-1-${feature}-view.png`, { appState: `${file} cropped to the Model viewport.`, crop: VIEWPORT_BOX, wholeFrame: file })
        await orbit(true)
        for (const id of glyphIds) await tid(id).click()
      }
      await h.chooseStarterMachine()
      await h.page.getByTestId('mode-tab-part').click()
      await h.page.getByTestId('model-entry-new').click()
      await h.page.getByTestId('workbench-new-sketch').waitFor({ timeout: 60_000 })
      await h.page.waitForFunction(() => !document.body.innerText.includes('initializing geometry kernel'), null, { timeout: 30_000 })
      await h.page.getByTestId('workbench-new-sketch').click()
      await h.page.mouse.click(1175, 367)
      await h.page.getByTestId('workbench-package-tool-rect-corner').waitFor()
      await h.page.waitForTimeout(1200)
      await h.page.getByTestId('workbench-package-tool-rect-corner').click()
      await h.page.mouse.click(1070, 450)
      await h.page.mouse.click(1160, 550)
      await h.page.keyboard.press('Escape')
      await h.page.getByTestId('workbench-finish-package-sketch').click()
      await h.page.getByTestId('workbench-revolve').click()
      await h.debug('native-revolve-dialog')
      await h.page.getByTestId('dialog-shell-apply').click()
      await h.page.getByTestId('dialog-shell-apply').waitFor({ state: 'detached' })
      await h.page.waitForFunction(() => document.querySelector('[data-testid="workbench-status-bodies"]')?.textContent === '1 bodies')
      await shootResult('revolve')
      await tid('workbench-undo').click()
      await page.waitForFunction(() => document.querySelector('[data-testid="workbench-status-bodies"]')?.textContent === '0 bodies')
      await tid('workbench-sweep').click()
      await tid('sweep-path-axis-select').selectOption('y')
      await tid('sweep-length').locator('input').fill('60')
      await tid('sweep-length').locator('input').press('Tab')
      await tid('dialog-shell-apply').click()
      await tid('dialog-shell-apply').waitFor({ state: 'detached' })
      await page.waitForFunction(() => document.querySelector('[data-testid="workbench-status-bodies"]')?.textContent === '1 bodies')
      await shootResult('sweep')
      await tid('workbench-undo').click()
      await page.waitForFunction(() => document.querySelector('[data-testid="workbench-status-bodies"]')?.textContent === '0 bodies')
      await tid('workbench-offset-plane').click()
      await tid('offset-plane-source').selectOption('datum:XZ')
      await tid('offset-plane-distance').fill('50')
      await tid('offset-plane-distance').press('Tab')
      await tid('dialog-shell-apply').click()
      await tid('dialog-shell-apply').waitFor({ state: 'detached' })
      await tid('workbench-new-sketch').click()
      await page.mouse.click(1175, 250)
      await tid('workbench-package-tool-rect-corner').waitFor()
      await page.waitForTimeout(1000)
      await tid('workbench-package-tool-rect-corner').click()
      await page.mouse.click(1070, 470)
      await page.mouse.click(1130, 530)
      await page.keyboard.press('Escape')
      await tid('workbench-finish-package-sketch').click()
      await tid('workbench-loft').click()
      await page.getByText('Choose sections by name fallback', { exact: true }).click()
      await tid('loft-section1-select').selectOption('sketch3d:SK1')
      await tid('loft-section2-select').selectOption('sketch3d:SK2')
      await h.debug('native-loft-dialog')
      await tid('dialog-shell-apply').click()
      await tid('dialog-shell-apply').waitFor({ state: 'detached' })
      await page.waitForFunction(() => document.querySelector('[data-testid="workbench-status-bodies"]')?.textContent === '1 bodies')
      await shootResult('loft')
    },
  },

  // T-3 - V-carving: the name-sign example's V-carve.
  'T-3': {
    async run(h) {
      await camOperation(h, { gap: 'T-3', project: 'examples/05-name-sign/name-sign.camproject', op: /V-carve/, file: 'T-3-vcarve', zoom: 4,
        appState: 'examples/05-name-sign/name-sign.camproject opened with Open project (starter machine).' })
    },
  },
  // 3-1 / 3-2 / 3-3 - the knob example's three 3D operations.
  // 3-1 / 3-2 / 3-3 - the knob example's three 3D operations, one session (one REGEN ALL).
  '3D': {
    async run(h) {
      const project = 'examples/06-knob-handwheel/knob-handwheel.camproject'
      const appState = `${project} opened with Open project (starter machine).`
      await camOperation(h, { gap: '3-1', project, op: /3D Rough/, file: '3-1-adaptive-3d', zoom: 4, appState })
      await camOperation(h, { gap: '3-2', project, op: /3D Finish/, file: '3-2-parallel-3d', zoom: 0, appState, reuse: true })
      await camOperation(h, { gap: '3-3', project, op: /Waterline/, file: '3-3-waterline-3d', zoom: 0, appState, reuse: true })
    },
  },

  // T-1 - Tool Library: a new tool with Type = Probe.
  'T-1': {
    async run(h) {
      const { page } = h
      await h.chooseStarterMachine()
      await page.getByRole('button', { name: /Tool Library/ }).first().click()
      await page.waitForTimeout(1200)
      await page.locator('.modal-container').getByRole('button', { name: /^\+?\s*New$/ }).first().click()
      await page.waitForTimeout(1000)
      // Type is on the General tab; the probe fields are on Cutter.
      await page.locator('.modal-container').getByText('General', { exact: true }).first().click()
      await page.waitForTimeout(500)
      const typeSelect = page.locator('.modal-container select').filter({ has: page.locator('option[value="probe"]') }).first()
      await typeSelect.selectOption('probe')
      await page.waitForTimeout(600)
      await page.locator('.modal-container').getByText('Cutter', { exact: true }).first().click()
      await page.waitForTimeout(1200)
      await h.debug('01-probe')
      const name = 'T-1-tool-library-probe.png'
      await h.shot(name)
      h.sidecar(name, { appState: 'Tool Library (top bar), New pressed, Type set to Probe: the Cutter tab with the ball / stylus / stem fields and the probe diagram, and the Probe section (Probe input, NO/NC, radius). Whole frame.' })
      const box = await h.box(page.locator('.modal-container').first())
      const crop = 'T-1-tool-library-probe-dialog.png'
      await h.crop(name, crop, box)
      h.sidecar(crop, { appState: `${name} cropped to the Tool Library window.`, crop: box, wholeFrame: name })
    },
  },

  // S-1 - Settings > User Data; then Download backup and Inspect backup... -> the restore review.
  'S-1': {
    async run(h) {
      const { page } = h
      await h.chooseStarterMachine()
      await page.getByRole('button', { name: 'Application settings', exact: true }).click()
      await page.getByTestId('user-data-storage-panel').waitFor()
      await page.getByTestId('user-data-storage-panel').scrollIntoViewIfNeeded()
      await page.waitForTimeout(1000)
      const a = 'S-1a-user-data.png'
      await h.shot(a)
      const modal = await h.box(page.locator('.modal-container').first())
      h.sidecar(a, { appState: 'Settings (top bar), scrolled to User Data: each kind of data with its count, Choose folder and sync, Download backup, Inspect backup..., Recover previous generation. Fresh first-start profile. Whole frame.' })
      await h.crop(a, 'S-1a-user-data-dialog.png', modal)
      h.sidecar('S-1a-user-data-dialog.png', { appState: `${a} cropped to the Settings window.`, crop: modal, wholeFrame: a })
      // Download backup -> the browser's download; then Inspect backup... with that file.
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.getByRole('button', { name: /^Download backup$/ }).click(),
      ])
      const saved = path.join(EVIDENCE, 'debug', 'S-1-backup.json')
      fs.mkdirSync(path.dirname(saved), { recursive: true })
      await download.saveAs(saved)
      const [fc] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15_000 }),
        page.getByText('Inspect backup...', { exact: true }).click(),
      ])
      await fc.setFiles(saved)
      await page.getByTestId('user-data-restore-preview').waitFor({ timeout: 30_000 })
      await page.getByTestId('user-data-restore-preview').scrollIntoViewIfNeeded()
      await page.waitForTimeout(800)
      const b = 'S-1b-restore-review.png'
      await h.shot(b)
      h.sidecar(b, { appState: 'Same session: Download backup pressed (the browser saved the bundle), then Inspect backup... given that file: the restore review with the bundle date, checksum, counts and Confirm restore / Cancel (not pressed). Whole frame.', extra: { backupBytes: fs.statSync(saved).size } })
      await h.crop(b, 'S-1b-restore-review-dialog.png', modal)
      h.sidecar('S-1b-restore-review-dialog.png', { appState: `${b} cropped to the Settings window.`, crop: modal, wholeFrame: b })
      fs.rmSync(saved, { force: true })
    },
  },

  // K-1 - Sketch tab: a reference image in Calibrate with two marks picked and the distance box.
  'K-1': {
    async run(h) {
      const { page } = h
      await h.chooseStarterMachine()
      await page.getByTestId('mode-tab-sketch').click()
      await page.getByText('New sketch', { exact: true }).click()
      await page.waitForTimeout(2000)
      await page.getByTestId('cam-sketch-import-into-sketch').click()
      await page.waitForTimeout(600)
      const [fc] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15_000 }),
        page.getByTestId('reference-image-insert').first().click(),
      ])
      await fc.setFiles(path.resolve('examples/07-relief-medallion/medallion.png'))
      await page.getByTestId('reference-image-palette').waitFor({ timeout: 30_000 })
      await page.waitForTimeout(1500)
      await h.debug('01-inserted')
      await page.getByTestId('reference-image-calibrate').click()
      await page.waitForTimeout(800)
      await page.mouse.click(820, 400)
      await page.waitForTimeout(500)
      await page.mouse.click(1120, 400)
      await page.waitForTimeout(1200)
      await h.debug('02-marks')
      await page.getByTestId('reference-image-distance-entry').waitFor({ timeout: 10_000 })
      const name = 'K-1-reference-image-calibrate.png'
      await h.shot(name)
      h.sidecar(name, { appState: 'Sketch tab, New sketch; Import into sketch > Reference image (tracing underlay) given examples/07-relief-medallion/medallion.png; the Reference image panel open; Calibrate pressed and two marks clicked on the picture: the distance box (current distance, Real distance) beside them. Whole frame.' })
    },
  },

  // H-2 - first start of the release browser demo / desktop app: "Try an example".
  'H-2': {
    demoBuild: true,
    async run(h) {
      const { page } = h
      await page.getByText('Try an example', { exact: true }).waitFor({ timeout: 60_000 })
      // The picker mounts behind the splash. Visible title alone is not proof
      // that the operator can see it (WO-2716's rejected first take).
      await page.locator('#liencam-splash').waitFor({ state: 'detached', timeout: 30_000 })
      const picker = page.getByRole('dialog', { name: 'Try an example' })
      await picker.getByRole('button', { name: 'Start with an empty project' }).waitFor()
      const name = 'H-2-try-an-example.png'
      await h.shot(name)
      h.sidecar(name, { appState: 'First start (empty browser storage) of a production build made with VITE_DEMO_BUILD=true, the switch the release browser demo uses; the installed desktop app shows the same picker (offersStartupExamples). "Try an example": Full Suite, the CNC starter kit examples and Start with an empty project. Whole frame.' })
      const box = await h.box(picker)
      const crop = 'H-2-try-an-example-dialog.png'
      await h.crop(name, crop, box)
      h.sidecar(crop, { appState: `${name} cropped to the Try an example window.`, crop: box, wholeFrame: name })
    },
  },
}
