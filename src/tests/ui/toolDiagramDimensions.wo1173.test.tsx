// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolDiagram, type ToolDiagramProps } from '../../components/modals/ToolDiagram'
import type { Tool } from '../../types'
import { buildToolProfile, radiusAtZ } from '../../lib/tool/toolProfile'

const fixtures: Array<{ name: string; props: ToolDiagramProps }> = [
  {
    name: 'standard flat end mill',
    props: {
      type: 'flat_end_mill', diameter: 6, shankDiameter: 8, overallLength: 50,
      fluteLength: 18, shoulderLength: 22, lengthBelowHolder: 28, coating: 'tin',
    },
  },
  {
    name: 'hairline drill',
    props: {
      type: 'drill', diameter: 3, shankDiameter: 3, overallLength: 100,
      fluteLength: 70, shoulderLength: 78, lengthBelowHolder: 85,
      angleFromAxisDeg: 59, coating: 'none',
    },
  },
  {
    name: 'wide face mill',
    props: {
      type: 'face_mill', diameter: 50, shankDiameter: 16, overallLength: 80,
      fluteLength: 8, shoulderLength: 20, lengthBelowHolder: 40, coating: 'tialn',
    },
  },
  {
    name: 'wide slitting saw',
    props: {
      type: 'slitting_saw', diameter: 80, shankDiameter: 12, overallLength: 60,
      fluteLength: 2, shoulderLength: 20, lengthBelowHolder: 35,
      neckDiameter: 6, coating: 'none',
    },
  },
  {
    name: 'realistic v bit with cone taller than flute',
    props: {
      type: 'v_bit', diameter: 12, shankDiameter: 6, overallLength: 50,
      fluteLength: 10, shoulderLength: 16, lengthBelowHolder: 25,
      angleFromAxisDeg: 30, coating: 'none',
    },
  },
  {
    name: 'extreme v bit with cone taller than flute',
    props: {
      type: 'v_bit', diameter: 32, shankDiameter: 8, overallLength: 80,
      fluteLength: 18, shoulderLength: 28, lengthBelowHolder: 45,
      angleFromAxisDeg: 15, coating: 'none',
    },
  },
  {
    name: 'extreme chamfer mill with cone taller than flute',
    props: {
      type: 'chamfer_mill', diameter: 32, shankDiameter: 8, overallLength: 90,
      fluteLength: 15, shoulderLength: 25, lengthBelowHolder: 50,
      angleFromAxisDeg: 30, coating: 'none',
    },
  },
  {
    name: 'extreme countersink with cone taller than flute',
    props: {
      type: 'countersink', diameter: 50, shankDiameter: 12, overallLength: 80,
      fluteLength: 12, shoulderLength: 22, lengthBelowHolder: 45,
      angleFromAxisDeg: 45, coating: 'none',
    },
  },
]

const numberAttr = (element: Element, name: string) => Number(element.getAttribute(name))
const dimensionLine = (svg: SVGSVGElement, key: string) => {
  const line = svg.querySelector(`.tool-diagram-dimension-line[data-dimension-key="${key}"]`)
  if (!line) throw new Error(`Missing dimension line ${key}`)
  return line
}

function asTool(props: ToolDiagramProps): Tool {
  return {
    id: 'test', name: '', numberOfFlutes: 0, material: 'carbide', notes: '', feedsAndSpeeds: {},
    ...props,
  }
}

afterEach(cleanup)

describe('WO-1173 ToolDiagram drafting dimensions', () => {
  it.each(fixtures)('$name attaches every dimension to profile-derived feature anchors', ({ props }) => {
    const { container } = render(<ToolDiagram {...props} />)
    const svg = container.querySelector('svg')
    if (!svg) throw new Error('Missing tool diagram')
    const scale = Number(svg.dataset.profileScale)
    const cx = Number(svg.dataset.centerX)
    const tipY = Number(svg.dataset.drawingBottom)
    const profile = buildToolProfile(asTool(props))
    const maxZ = Math.max(...profile.vertices.map((vertex) => vertex.z))
    const cuttingR = props.diameter / 2

    const oal = dimensionLine(svg, 'oal')
    expect(numberAttr(oal, 'y1')).toBeCloseTo(tipY - maxZ * scale, 6)
    expect(numberAttr(oal, 'y2')).toBeCloseTo(tipY, 6)
    const flute = dimensionLine(svg, 'flute')
    expect(numberAttr(flute, 'y1')).toBeCloseTo(tipY - profile.cuttingMaxZ * scale, 6)
    expect(numberAttr(flute, 'y2')).toBeCloseTo(tipY, 6)
    const lbh = dimensionLine(svg, 'lbh')
    const expectedLbh = Math.min(props.lengthBelowHolder ?? Math.max(props.fluteLength, props.shoulderLength ?? 0), maxZ)
    expect(numberAttr(lbh, 'y1')).toBeCloseTo(tipY - expectedLbh * scale, 6)
    expect(numberAttr(lbh, 'y2')).toBeCloseTo(tipY, 6)

    const cutter = dimensionLine(svg, 'cutter-diameter')
    expect(numberAttr(cutter, 'x1')).toBeCloseTo(cx - cuttingR * scale, 6)
    expect(numberAttr(cutter, 'x2')).toBeCloseTo(cx + cuttingR * scale, 6)
    expect(numberAttr(cutter, 'x2') - numberAttr(cutter, 'x1')).toBeCloseTo(props.diameter * scale, 6)
    expect(numberAttr(cutter, 'x2')).toBeGreaterThan(numberAttr(cutter, 'x1'))
    expect(numberAttr(cutter, 'y1')).toBe(numberAttr(cutter, 'y2'))
    const cutterExtension = svg.querySelector('[data-dimension-key="cutter-diameter"] .tool-diagram-extension-line')
    if (!cutterExtension) throw new Error('Missing cutter extension line')
    const cutterAnchorZ = (tipY - (numberAttr(cutterExtension, 'y1') - 3)) / scale
    expect(radiusAtZ(profile, cutterAnchorZ)).toBeCloseTo(cuttingR, 5)

    const axial = ['flute', 'lbh', 'oal'].map((key) => dimensionLine(svg, key))
    const ordered = [...axial].sort((a, b) => Math.abs(numberAttr(a, 'y2') - numberAttr(a, 'y1')) - Math.abs(numberAttr(b, 'y2') - numberAttr(b, 'y1')))
    const columns = ordered.map((line) => numberAttr(line, 'x1'))
    expect(new Set(columns).size).toBe(columns.length)
    expect(columns[1] - columns[0]).toBeCloseTo(34, 6)
    expect(columns[2] - columns[1]).toBeCloseTo(34, 6)

    for (const line of axial) {
      const key = line.getAttribute('data-dimension-key')
      const label = svg.querySelector(`[data-dimension-label-for="${key}"]`)
      expect(numberAttr(label!, 'x')).toBeGreaterThan(numberAttr(line, 'x1'))
      expect(numberAttr(label!, 'y')).toBeCloseTo((numberAttr(line, 'y1') + numberAttr(line, 'y2')) / 2, 6)
      expect(label?.getAttribute('text-anchor')).toBe('middle')
    }

    for (const line of svg.querySelectorAll('.tool-diagram-dimension-line')) {
      const key = line.getAttribute('data-dimension-key')
      expect(svg.querySelector(`[data-dimension-label-for="${key}"]`)).not.toBeNull()
    }
    expect(svg.textContent).not.toContain('ledger')
  })

  it('draws a differing shank diameter above the shank at its exact profile width', () => {
    const props = fixtures[0].props
    const { container } = render(<ToolDiagram {...props} />)
    const svg = container.querySelector('svg')!
    const line = dimensionLine(svg, 'shank-diameter')
    const scale = Number(svg.dataset.profileScale)
    const cx = Number(svg.dataset.centerX)
    expect(numberAttr(line, 'x1')).toBeCloseTo(cx - props.shankDiameter / 2 * scale, 6)
    expect(numberAttr(line, 'x2')).toBeCloseTo(cx + props.shankDiameter / 2 * scale, 6)
    expect(numberAttr(line, 'y1')).toBeLessThan(Number(svg.dataset.anchorTopY))
    const label = svg.querySelector('[data-dimension-label-for="shank-diameter"]')!
    expect(numberAttr(label, 'y')).toBeLessThan(numberAttr(line, 'y1'))
  })

  it('uses outside-in arrows and a beside-the-line label for a hairline drill', () => {
    const { container } = render(<ToolDiagram {...fixtures[1].props} />)
    const group = container.querySelector('[data-dimension-key="cutter-diameter"]')
    expect(group?.querySelectorAll('path')).toHaveLength(2)
    const line = group?.querySelector('.tool-diagram-dimension-line')
    const label = group?.querySelector('.tool-diagram-dimension-label')
    expect(numberAttr(label!, 'x')).toBeGreaterThan(numberAttr(line!, 'x2'))
    expect(numberAttr(label!, 'y')).toBeGreaterThan(numberAttr(line!, 'y1'))
  })

  it('attaches angle text directly to a flank leader using the per-side convention', () => {
    const props = fixtures[1].props
    const { container } = render(<ToolDiagram {...props} />)
    const svg = container.querySelector('svg')!
    const angle = container.querySelector('[data-dimension-key="tip-angle"]')
    const line = angle?.querySelector('.tool-diagram-dimension-line')
    expect(line?.getAttribute('data-dimension-kind')).toBe('angular')
    expect(angle?.querySelector('.tool-diagram-dimension-label')?.textContent).toContain('59 deg/side')

    const profile = buildToolProfile(asTool(props))
    const flank = profile.vertices.slice(0, -1).map((a, index) => ({ a, b: profile.vertices[index + 1] })).find(({ a, b }) => (
      b.z > a.z + 1e-7 && a.z < profile.cuttingMaxZ - 1e-7 && Math.abs(b.r - a.r) > 1e-7
    ))
    if (!flank) throw new Error('Expected the drill profile to have a tip flank')
    const anchorZ = flank.a.z + (Math.min(profile.cuttingMaxZ, flank.b.z) - flank.a.z) / 2
    const anchorR = flank.a.r + (flank.b.r - flank.a.r) * ((anchorZ - flank.a.z) / (flank.b.z - flank.a.z))
    const scale = Number(svg.dataset.profileScale)
    const cx = Number(svg.dataset.centerX)
    const tipY = Number(svg.dataset.drawingBottom)
    expect(numberAttr(line!, 'x1')).toBeCloseTo(cx - anchorR * scale, 6)
    expect(numberAttr(line!, 'y1')).toBeCloseTo(tipY - anchorZ * scale, 6)
    expect(numberAttr(line!, 'x1')).toBeGreaterThan(cx - props.diameter / 2 * scale)
  })
})
