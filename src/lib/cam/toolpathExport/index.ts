import type { ToolpathMove } from '../../../types'

export type ToolpathExportFormat = 'dxf' | 'svg'
type Path = { layer: 'RAPID' | 'CUT'; vertices: ToolpathMove[] }

// Moves are stored in machine/world millimetres. Keep that frame and every
// endpoint, including Z, rather than applying postprocessor/WCS rounding.
// Repeat the previous endpoint at a layer transition: it starts the segment
// arriving at the new move, and prevents a missing rapid/plunge at each join.
function paths(moves: readonly ToolpathMove[]): Path[] {
  const result: Path[] = []
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i]
    if (![move.x, move.y, move.z].every(Number.isFinite)) {
      throw new Error('Toolpath contains a non-finite coordinate')
    }
    const layer = move.type === 'rapid' || move.role === 'rapid' ? 'RAPID' : 'CUT'
    const last = result.at(-1)
    if (last?.layer === layer) {
      last.vertices.push(move)
    } else {
      result.push({ layer, vertices: i ? [moves[i - 1], move] : [move] })
    }
  }
  return result
}

export function toolpathDxf(moves: readonly ToolpathMove[]): string {
  const lines: string[] = []
  const pair = (code: number, value: string | number) => { lines.push(String(code), String(value)) }
  let handle = 256
  const entity = (kind: string, layer: string, subclasses: string[]) => {
    pair(0, kind); pair(5, (handle++).toString(16).toUpperCase())
    pair(100, 'AcDbEntity'); pair(8, layer)
    for (const subclass of subclasses) pair(100, subclass)
  }
  pair(0, 'SECTION'); pair(2, 'HEADER')
  pair(9, '$ACADVER'); pair(1, 'AC1015')
  pair(9, '$INSUNITS'); pair(70, 4) // millimetres
  pair(0, 'ENDSEC')
  pair(0, 'SECTION'); pair(2, 'TABLES')
  pair(0, 'TABLE'); pair(2, 'LAYER'); pair(100, 'AcDbSymbolTable'); pair(70, 2)
  for (const [name, color] of [['CUT', 3], ['RAPID', 1]] as const) {
    pair(0, 'LAYER'); pair(5, (handle++).toString(16).toUpperCase())
    pair(100, 'AcDbSymbolTableRecord'); pair(100, 'AcDbLayerTableRecord')
    pair(2, name); pair(70, 0); pair(62, color); pair(6, 'CONTINUOUS')
  }
  pair(0, 'ENDTAB'); pair(0, 'ENDSEC')
  pair(0, 'SECTION'); pair(2, 'ENTITIES')
  for (const path of paths(moves)) {
    entity('POLYLINE', path.layer, ['AcDb3dPolyline']); pair(66, 1); pair(70, 8)
    pair(10, 0); pair(20, 0); pair(30, 0)
    for (const vertex of path.vertices) {
      entity('VERTEX', path.layer, ['AcDbVertex', 'AcDb3dPolylineVertex']); pair(70, 32)
      pair(10, vertex.x); pair(20, vertex.y); pair(30, vertex.z)
    }
    entity('SEQEND', path.layer, [])
  }
  pair(0, 'ENDSEC'); pair(0, 'EOF')
  return lines.join('\n') + '\n'
}

export function toolpathSvg(moves: readonly ToolpathMove[]): string {
  const polylines = paths(moves)
  let minX = 0, maxX = 0, minY = 0, maxY = 0
  if (moves.length) {
    minX = maxX = moves[0].x; minY = maxY = moves[0].y
    for (const move of moves) {
      minX = Math.min(minX, move.x); maxX = Math.max(maxX, move.x)
      minY = Math.min(minY, move.y); maxY = Math.max(maxY, move.y)
    }
  }
  const padding = 1
  const width = maxX - minX + padding * 2, height = maxY - minY + padding * 2
  // SVG's Y axis points down. A group transform preserves the original XY
  // vertex values while displaying the CAD view with positive Y upwards.
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="${minX - padding} ${-maxY - padding} ${width} ${height}">`,
    '<title>Toolpath XY view (machine coordinates, millimetres)</title>',
    '<g transform="scale(1,-1)" fill="none" stroke-width="0.1">',
    ...polylines.map(path => `<polyline data-layer="${path.layer}" stroke="${path.layer === 'RAPID' ? '#cc3333' : '#228833'}" points="${path.vertices.map(v => `${v.x},${v.y}`).join(' ')}"/>`),
    '</g>', '</svg>', '',
  ].join('\n')
}
