// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const pagePath = join(root, 'docs/wiki/Walkthrough-Picture-to-Relief.md')
const page = readFileSync(pagePath, 'utf8').replaceAll('\r\n', '\n')
const links = [...page.matchAll(/(!?)\[[^\]]*\]\(([^)]+)\)/g)].map(m => ({ picture: m[1] === '!', target: m[2] }))
const manifest = JSON.parse(readFileSync(join(root, 'tools/capture/scenes.json'), 'utf8'))
const scenes = (manifest.walkthroughScenes as { id: string; page: string; project: string }[]).filter(s => s.page === 'Walkthrough-Picture-to-Relief')

describe('WO-2544 Picture-to-Relief walkthrough', () => {
  it('is a real walkthrough: no pending stub, numbered steps, one picture per section', () => {
    expect(page).not.toMatch(/pending/i)
    expect(page).not.toContain('WO-2446')
    expect([...page.matchAll(/^\d+\. /gm)].length).toBeGreaterThanOrEqual(8)
    expect(links.filter(l => l.picture).length).toBe(5)
  })

  it('resolves every link and picture', () => {
    for (const { target } of links) {
      const clean = target.split('#')[0]
      if (!clean) continue
      // WO-2626 uses GitHub's published-wiki link to the repository tree.
      // Verify that same target locally instead of looking for docs/blob/main.
      const destination = clean.startsWith('../blob/main/')
        ? resolve(root, clean.slice('../blob/main/'.length))
        : clean.includes('/') ? resolve(dirname(pagePath), clean) : join(root, 'docs/wiki', `${clean}.md`)
      expect(existsSync(destination), target).toBe(true)
    }
  })

  it('every picture is a scene on example 07 with a captured, provenanced PNG', () => {
    expect(scenes.map(s => s.id)).toEqual(['W9-1', 'W9-2', 'W9-3', 'W9-4', 'W9-5'])
    for (const scene of scenes) {
      expect(scene.project).toBe('examples/07-relief-medallion/relief-medallion.camproject')
      // WO-2536: the published wiki carries its own copies; ../media leaves the wiki.
      expect(page).toContain(`](images/walkthroughs/${scene.id}.png)`)
      expect(page).not.toContain(`../media/walkthroughs/${scene.id}.png`)
      expect(existsSync(join(root, 'docs/media/walkthroughs', `${scene.id}.png`))).toBe(true)
      expect(existsSync(join(root, 'docs/media/walkthroughs', `${scene.id}.json`))).toBe(true)
      expect(readFileSync(join(root, 'docs/wiki/images/walkthroughs', `${scene.id}.png`)))
        .toEqual(readFileSync(join(root, 'docs/media/walkthroughs', `${scene.id}.png`)))
    }
  })

  it('names the holding sequence the saved example really uses', () => {
    const project = JSON.parse(readFileSync(join(root, scenes[0].project), 'utf8'))
    const setup = project.setups[0]
    expect(setup.holdingMethod).toBe('screws')
    expect(setup.operations.map((o: { name: string }) => o.name)).toEqual(['Drill 1', '3D Rough 2', '3D Finish 3', 'Contour 4'])
    expect(JSON.stringify(setup)).toContain('Operator stop')
    for (const text of ['Drill 1', 'Operator stop', '3D Rough 2', '3D Finish 3', 'Contour 4', 'Emboss', 'Raise', 'Engrave']) expect(page).toContain(text)
    expect(setup.workholdingNote ?? JSON.stringify(setup)).toContain('Drive 4 screws, remove the 2 clamps')
  })
})
