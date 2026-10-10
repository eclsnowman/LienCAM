// Reimplemented for LienCAM's flat group-code scanner after studying PureCutCNC
// (1597362). No upstream code is copied; coordinates remain DXF's Y-up.
import type { Vec2 } from '../../types'

export interface DxfPair { code: number; value: string }
export interface DxfBlock { base: Vec2; entities: DxfPair[] }

/** BLOCK definitions are data, not placed geometry. Keep their entity stream
 * intact so the existing importer also handles legacy POLYLINE/SEQEND runs. */
export function parseBlocks(pairs: DxfPair[]): Map<string, DxfBlock> {
  const blocks = new Map<string, DxfBlock>()
  let inBlocks = false
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]
    if (pair.code === 0 && pair.value === 'SECTION') {
      inBlocks = pairs[i + 1]?.code === 2 && pairs[i + 1].value === 'BLOCKS'
    }
    if (pair.code === 0 && pair.value === 'ENDSEC') inBlocks = false
    if (!inBlocks || pair.code !== 0 || pair.value !== 'BLOCK') continue
    let name = '', x = 0, y = 0
    for (i++; i < pairs.length && pairs[i].code !== 0; i++) {
      const { code, value } = pairs[i]
      if (code === 2 || (code === 3 && !name)) name = value
      else if (code === 10) x = Number.parseFloat(value) || 0
      else if (code === 20) y = Number.parseFloat(value) || 0
    }
    const start = i
    while (i < pairs.length && !(pairs[i].code === 0 &&
      ['ENDBLK', 'ENDSEC', 'BLOCK'].includes(pairs[i].value))) i++
    if (name) blocks.set(name.toUpperCase(), { base: { x, y }, entities: pairs.slice(start, i) })
    i-- // Let the outer scanner consume the terminator / next block.
  }
  return blocks
}

export function insertName(pairs: DxfPair[]): string {
  return pairs.find(p => p.code === 2)?.value ?? ''
}
function number(pairs: DxfPair[], code: number, fallback = 0): number {
  const value = Number.parseFloat(pairs.find(p => p.code === code)?.value ?? '')
  return Number.isFinite(value) ? value : fallback
}

export function isModelSpaceInsert(pairs: DxfPair[]): boolean {
  const layout = pairs.find(p => p.code === 410)?.value.toLowerCase()
  return number(pairs, 67) !== 1 && (!layout || layout === 'model')
}

/** T(insert + rotated array offset) * R * S * T(-base), then OCS -> WCS.
 * Array spacing rotates but is not scaled by the instance's X/Y factors.
 * For extrusion (0,0,-1), OCS's X axis is WCS -X: mirror the complete placed
 * X coordinate, including the insertion point, after rotating in OCS. */
export function* insertPlacements(
  pairs: DxfPair[], block: DxfBlock, unitScale: number,
): Generator<(point: Vec2) => Vec2> {
  const x = number(pairs, 10) * unitScale, y = number(pairs, 20) * unitScale
  const sx = number(pairs, 41, 1), sy = number(pairs, 42, 1)
  const angle = number(pairs, 50) * Math.PI / 180
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const mirror = number(pairs, 210) === 0 && number(pairs, 220) === 0 && number(pairs, 230, 1) < 0 ? -1 : 1
  const cols = Math.max(1, Math.trunc(number(pairs, 70, 1)))
  const rows = Math.max(1, Math.trunc(number(pairs, 71, 1)))
  const dx = number(pairs, 44) * unitScale, dy = number(pairs, 45) * unitScale
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const ox = x + cos * col * dx - sin * row * dy
      const oy = y + sin * col * dx + cos * row * dy
      yield point => {
        const px = (point.x - block.base.x * unitScale) * sx
        const py = (point.y - block.base.y * unitScale) * sy
        return { x: mirror * (ox + cos * px - sin * py), y: oy + sin * px + cos * py }
      }
    }
  }
}
