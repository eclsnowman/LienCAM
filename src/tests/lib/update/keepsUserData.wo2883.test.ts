// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// WO-2883 / ADR-0059: an update keeps your data. The desktop app's user data
// lives in the Electron userData folder (named by productName) and in the
// renderer's storage for the liencam://app origin. An update that changed any
// of these would start the operator on an empty store, so they are pinned.
// The before/after diff of a real profile is the machine seat's MACHINE-TEST row.

const builder = readFileSync('electron-builder.yml', 'utf8')
const main = readFileSync('electron/main.cjs', 'utf8')
// Code only: the module's comments explain the rule and name userData.
const updater = readFileSync('electron/update/updater.cjs', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

describe('WO-2883 an update keeps the operator\'s data (ADR-0059)', () => {
  it('keeps the app identity that names the userData folder', () => {
    expect(builder).toMatch(/^appId: com\.liencam\.desktop$/m)
    expect(builder).toMatch(/^productName: LienCAM$/m)
    expect(pkg.name).toBe('liencam')
  })
  it('keeps the renderer origin its storage belongs to', () => {
    expect(main).toContain("const APP_SCHEME = 'liencam'")
    expect(main).toContain("const APP_HOST = 'app'")
  })
  it('never lets the installer delete app data', () => {
    expect(builder).not.toMatch(/deleteAppDataOnUninstall:\s*true/)
  })
  it('ships the update route with the app', () => {
    expect(builder).toMatch(/^\s+- electron\/update\/\*\*\/\*$/m)
  })
  it('the update route never reads or writes userData', () => {
    expect(updater).not.toMatch(/userData|getPath\(/)
  })
})
