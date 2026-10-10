// WO-2161: the Troubleshooting help describes what the app does today.
//
// Each check ties a help sentence to the thing it describes: where the app's
// own code can produce the words (the mesh converter, the mesh boolean, the
// tree right-click menu), the test runs that code and compares; the rest pin
// the words the running app showed in the WO-2161 walk
// (src/tests/evidence/WO-2161/screens/result*.json). Fails on the pre-fix
// help, which said curved meshes are refused, sent the GPU fallback to the
// browser developer console, called the view Retry button "Retry", said the
// last-resort reset clears only the project, and had no word about a
// conflicting constraint being taken back.

import { describe, expect, it } from 'vitest'
import { topics } from '../../help/topics/troubleshooting'
import { entries } from '../../help/topics/troubleshooting/entries'
import type { HelpTopic } from '../../help/types'
import { convertPrismaticMesh } from '../../mesh/prismatic'
import type { MeshBuffers } from '../../mesh/types'
import { describeBooleanFailure } from '../../lib/cam/booleanMeshModel'
import { buildTreeContextMenu } from '../../lib/tree/treeContextMenu'

function topicText(topic: HelpTopic): string {
  const parts: string[] = [topic.title, topic.summary]
  for (const section of topic.sections) {
    if (section.kind === 'steps') parts.push(...section.steps)
    else if (section.kind === 'table') parts.push(...section.rows.flatMap((r) => r.cells))
    else if (section.kind !== 'image') parts.push(section.text)
  }
  return parts.join('\n')
}

const text = (id: string): string => {
  const topic = topics.find((t) => t.id === id)
  if (!topic) throw new Error(`no troubleshooting topic ${id}`)
  return topicText(topic)
}

// A 40 x 30 x 20 box with its lid missing: 10 triangles, one 4-edge hole.
function openBox(): MeshBuffers {
  const v = [
    [0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0],
    [0, 0, 20], [40, 0, 20], [40, 30, 20], [0, 30, 20],
  ]
  const quads = [
    [0, 3, 2, 1], // bottom
    [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], // sides
  ]
  const indices = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])
  return { positions: new Float32Array(v.flat()), indices: new Uint32Array(indices) }
}

function cylinder(r: number, h: number, n: number): MeshBuffers {
  const pos: number[] = [0, 0, 0, 0, 0, h]
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    pos.push(r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(a), r * Math.sin(a), h)
  }
  const ring = (i: number, top: 0 | 1) => 2 + 2 * (i % n) + top
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    idx.push(0, ring(i + 1, 0), ring(i, 0))
    idx.push(1, ring(i, 1), ring(i + 1, 1))
    idx.push(ring(i, 0), ring(i + 1, 0), ring(i + 1, 1))
    idx.push(ring(i, 0), ring(i + 1, 1), ring(i, 1))
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) }
}

describe('WO-2161 troubleshooting help matches the app', () => {
  it('keeps every topic id and the index entries field-for-field equal', () => {
    expect(topics.map((t) => t.id)).toEqual([
      'outdated-after-open', 'blank-or-crashed', 'gpu-limits',
      'import-refusals', 'sketch-conflicts', 'missing-toolpath',
    ])
    for (const t of topics) {
      const e = entries.find((x) => x.id === t.id)
      expect(e).toEqual({
        id: t.id, title: t.title, category: t.category, summary: t.summary,
        keywords: t.keywords, contextKeys: t.contextKeys,
      })
    }
  })

  it('quotes the open-mesh refusal the converter really gives', () => {
    const result = convertPrismaticMesh(openBox())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('non-watertight')
    expect(text('import-refusals')).toContain(`"${result.message}"`)
  })

  it('does not claim a curved mesh is refused by Edit as model - it opens as a mesh', () => {
    const result = convertPrismaticMesh(cylinder(15, 20, 48))
    // The converter still calls it curved; the Edit as model route opens it
    // on the Model tab instead of refusing (seen in the walk: workspace
    // "part", row kept as STL).
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('refused-curved')
    const help = text('import-refusals')
    expect(help).not.toContain('cannot be converted to an editable solid because')
    expect(help).toContain('opens on the Model tab as a mesh and stays an STL')
    expect(help).toContain('is open as a mesh (kept as an STL)')
  })

  it('names the right-click items the help sends the operator to', () => {
    const geoMenu = buildTreeContextMenu({
      kind: 'geometry', geoId: 'g', canToggleVisibility: true, hidden: false, wrappable: true,
    } as Parameters<typeof buildTreeContextMenu>[0]).map((i) => i.label)
    expect(geoMenu).toContain('Edit as model')
    expect(text('import-refusals')).toContain('choose "Edit as model"')
    const opMenu = buildTreeContextMenu({
      kind: 'op', setupId: 's', opId: 'o', index: 0, count: 1, status: 'outdated', enabled: true,
    }).map((i) => i.label)
    expect(opMenu).toContain('Regenerate')
    expect(text('outdated-after-open')).toContain('right-click the row and choose Regenerate')
  })

  it('quotes the mesh boolean refusal the app builds from a kernel manifold error', () => {
    const message = describeBooleanFailure(new Error('Not manifold'))
    const quoted = message.slice(0, message.indexOf(' (kernel:'))
    expect(text('import-refusals')).toContain(`"${quoted}"`)
  })

  it('sends the GPU fallback to the bottom console with its real words', () => {
    const help = text('gpu-limits')
    expect(help).toContain('"Voxel simulation unavailable (GPU lacks WebGL2 + float-3D-texture linear filtering); using 2.5D heightmap."')
    expect(help).not.toMatch(/developer console|\[stock-sim\]/)
    for (const option of ['Auto (3D, falls back to 2.5D)', '3D - smooth, true undercuts', '2.5D - fast (low-end GPUs)']) {
      expect(help).toContain(`"${option}"`)
    }
  })

  it('describes both error screens with the buttons and reset scope they show', () => {
    const help = text('blank-or-crashed')
    expect(help).toContain('"Retry this view"')
    expect(help).toContain('"Reset Project Data & Reload (last resort)"')
    expect(help).toMatch(/current project, your tool library, holder library, machine library, app settings and imported fonts/)
  })

  it('says a contradicting constraint is taken back and named, and names the resolve controls', () => {
    const help = text('sketch-conflicts')
    expect(help).toContain('rejected: conflicts with')
    expect(help).toContain('"Conflicting set (N) - remove one to resolve"')
    expect(help).toContain('"Remove this constraint/dimension to resolve the conflict"')
    expect(help).toContain('"Redundant (N) - advisory, removal optional"')
  })

  it('quotes the missing-loop message the compute gives today', () => {
    const help = text('missing-toolpath')
    expect(help).toContain('no longer exists in the selected geometry scope.')
    expect(help).toContain('"Degraded - referenced model geometry is gone; re-select geometry."')
  })

  it('quotes the reload notice and the REGEN ALL button as the app shows them', () => {
    const help = text('outdated-after-open')
    expect(help).toContain('"2 operations need regeneration (toolpaths are not saved to browser storage). Use Regen All to recompute."')
    expect(help).toContain('REGEN ALL')
    expect(help).toContain('"Regenerate all toolpaths (Shift+G)"')
  })
})
