import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n')

// Text-only findings: exercise the published Markdown, using the actual picker
// labels and the release version as independent truth. No controller is started.
describe('WO-3090 first-run and Linux documentation', () => {
  it('20: locates the first example in the first-launch window and explains how to reopen it', () => {
    const quick = read('README.md').split('## Quick start\n')[1].split('\n## ')[0]
    const picker = read('src/components/modals/DemoExamplePickerModal.tsx')
    expect(picker).toContain('id="demo-example-title">Open a project</span>')
    expect(picker).toContain(">Examples</button>")
    expect(quick).toMatch(/first launch[^.]*\*\*Open a project\*\*/i)
    expect(quick).toMatch(/\*\*Examples\*\* at the top/)
    expect(quick).toMatch(/\*\*Full Suite\*\*[^.]*first example/)
    expect(quick).toMatch(/closed[^.]*\*\*Open\*\* at the top left[^.]*\*\*Examples\*\*/)
  })

  it('21: separates the current release from the dated native Linux board test', () => {
    const page = read('docs/wiki/Install-on-Linux.md')
    const { version } = JSON.parse(read('package.json')) as { version: string }
    expect(page).toContain(`**Current release:** [${version}](../releases/tag/v${version})`)
    // The Linux O61 session predates the Windows alpha.3.1 receipt. Do not
    // relabel that historical session as proof of a newer Linux release.
    expect(page).toContain('The Linux board test below was run before this release')
    const proven = page.split('**Proven on a real board (October 22, 2026):**')[1].split('\n\n')[0]
    expect(proven).toContain('Fedora 44 x86-64')
    expect(proven).toContain('native Linux bridge')
    expect(proven).not.toMatch(/0\.37\.0-alpha\.3\b/)
    expect(page).toContain('alpha.3.1 needs `LIENCAM_BRIDGE_NATIVE=1`')
    expect(page).toContain('alpha.3.2 uses it by default')
  })

  it('21: names the native bridge plainly instead of using route letters', () => {
    const page = read('docs/wiki/Install-on-Linux.md')
    expect(page).toContain('### Native Linux bridge')
    expect(page).not.toMatch(/\broute\s+[AB]\b/i)
    // Keep the actual support boundary while changing its name.
    expect(page).toContain('AXBB-E with firmware 1005 only')
    expect(page).toContain('USB UC100')
    expect(page).toContain('without Wine or vendor DLLs')
  })
})
