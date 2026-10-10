import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n')
const staleExportLine = 'A few exports are still being finished; each one is on the roadmap at top priority.'

describe('WO-2539 public text tells the truth', () => {
  it('F8: removes the completed-export caveat from all public copies, preserving the dated ADR', () => {
    for (const path of ['README.md', 'site/index.html', 'site/about.html']) {
      expect(read(path), path).not.toContain(staleExportLine)
    }
    expect(read('docs/decisions/0057-your-data-always-leaves-with-you.md')).toContain(staleExportLine)
  })

  it('F9: marks both shipped exports Done in the source and both generated roadmaps', () => {
    const roadmap = JSON.parse(read('docs/roadmap/roadmap.json'))
    for (const id of ['R-011', 'R-035']) {
      const row = roadmap.rows.find((candidate: { id: string }) => candidate.id === id)
      expect(row, id).toBeDefined()
      expect(row.status, id).toBe('done')
      expect(row.note, id).toBe('')
      const mdRow = read('ROADMAP.md').split('\n').find(line => line.startsWith(`| ${id} |`))
      expect(mdRow, id).toContain('| **Done** |')
      const htmlRow = read('site/roadmap.html').match(new RegExp(`<tr id="${id.toLowerCase()}"[^>]*>[\\s\\S]*?</tr>`))?.[0]
      expect(htmlRow, id).toContain('data-status="done"')
      expect(htmlRow, id).toContain('<span class="status-word">Done</span>')
    }
    const check = spawnSync(process.execPath, ['tools/release/roadmap.mjs', '--check'], { cwd: root, encoding: 'utf8' })
    expect(check.status, check.stdout + check.stderr).toBe(0)
  })

  it('F10: the home Post row matches the README and release promise, including Generic', () => {
    const wording = 'Post: UCCNC, GRBL, grblHAL, LinuxCNC and Generic dialects'
    expect(read('README.md')).toContain(`| ${wording} | SUPPORTED |`)
    expect(read('.planning/public-release/alpha-1/PLAN.md')).toContain(`| ${wording} | SUPPORTED |`)
    expect(read('site/index.html')).toContain(`<th scope="row">${wording}</th><td>SUPPORTED</td>`)
  })

  it('keeps every README and home capability/status row equal to the release promise table', () => {
    const markdownRows = (text: string, header: string) => text.split(header)[1].split('\n\n')[0].split('\n').slice(2)
      .filter(line => line.startsWith('|')).map(line => line.split('|').slice(1, 3).map(cell => cell.trim()))
    const promise = markdownRows(read('.planning/public-release/alpha-1/PLAN.md'), '| Capability | Status | Journey |')
    const readme = markdownRows(read('README.md').split('## What it does')[1].split('## Open by design')[0], '| Capability | Status |')
    const home = [...read('site/index.html').matchAll(/<th scope="row">([^<]+)<\/th><td>([^<]+)<\/td>/g)]
      .map(match => [match[1], match[2]])
    expect(promise).toHaveLength(16)
    expect(readme).toEqual(promise)
    expect(home).toEqual(promise)
  })

  it('F15: describes the shipped examples with the current name and without private proof pointers', () => {
    const examples = read('Example Projects/README.md')
    expect(examples).toContain('Open **Full Suite** from the first entry in **Try an example**')
    expect(examples).not.toContain('LienCNC CAM')
    expect(examples).not.toContain('the tray is dead')
    expect(examples).not.toContain('The Tray example was retired')
    expect(examples).toContain('`Full Suite.camproject` with File > Open')
    expect(examples).not.toContain('src/tests/')
    expect(examples).not.toContain('Feature Tour')
    expect(examples).toContain('Its four machining setups contain nine operations')
    expect(examples).toContain('Sample Parts/plate.camproject')
    expect(examples).toContain('Sample Parts/plate.stl')
  })
})
