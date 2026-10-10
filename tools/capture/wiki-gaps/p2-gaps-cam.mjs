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
  h.sidecar(full, { appState: `${appState} Toolpath tab, REGEN ALL pressed and finished; "${opName}" selected in the design tree, so the view shows its path and the Properties panel its summary; the view zoomed ${zoom} wheel steps toward the part. Whole frame.` })
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
      for (const t of ['Tool', 'Geometry', 'Passes', 'Heights']) {
        await tab(t).click()
        await page.waitForTimeout(800)
        await h.debug('tab-' + t)
      }
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
      await page.waitForTimeout(800)
      const name = 'H-2-try-an-example.png'
      await h.shot(name)
      h.sidecar(name, { appState: 'First start (empty browser storage) of a production build made with VITE_DEMO_BUILD=true, the switch the release browser demo uses; the installed desktop app shows the same picker (offersStartupExamples). "Try an example": Full Suite, the CNC starter kit examples and Start with an empty project. Whole frame.' })
      const box = await h.box(page.locator('.modal-container').first())
      const crop = 'H-2-try-an-example-dialog.png'
      await h.crop(name, crop, box)
      h.sidecar(crop, { appState: `${name} cropped to the Try an example window.`, crop: box, wholeFrame: name })
    },
  },
}
