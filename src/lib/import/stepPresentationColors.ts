/** Read STEP presentation metadata which occt-wasm currently omits from XCAF
 * label info. Geometry, body identity and placements still come exclusively
 * from the shared reader. Follow explicit STYLED_ITEM references, never assume
 * COLOUR_RGB order matches part order. Only unique named solid/shell styles
 * supplement a missing kernel colour; ambiguous names remain unassigned. */
export function readStepPresentationColors(bytes: ArrayBuffer): Map<string, [number, number, number]> {
  const text = new TextDecoder().decode(bytes)
  type Entity = { type: string; refs: string[]; name?: string; rgb?: [number, number, number] }
  const entities = new Map<string, Entity>()
  // Quoted strings (including doubled apostrophes) and comments are tokens so
  // embedded ;, #123 and ); cannot terminate or inject an entity/reference.
  let statement = ''
  for (const match of text.matchAll(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|;|[^';/]+|./g)) {
    const token = match[0]
    if (token.startsWith('/*')) continue
    if (token !== ';') { statement += token; continue }
    const parsed = statement.trim().match(/^#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(([\s\S]*)\)$/i)
    statement = ''
    if (!parsed) continue
    const [, id, type, args] = parsed
    const name = args.match(/^\s*'((?:[^']|'')*)'/)?.[1].replaceAll("''", "'")
    const raw = args.replace(/'(?:[^']|'')*'/g, "''")
    const refs = [...raw.matchAll(/#(\d+)/g)].map(m => m[1])
    const entity: Entity = { type: type.toUpperCase(), refs, name }
    if (entity.type === 'COLOUR_RGB') {
      const values = raw.slice(raw.indexOf(',') + 1).split(',').map(v => Number(v.trim().replace(/[dD]/, 'E')))
      if (values.length === 3 && values.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) {
        entity.rgb = values as [number, number, number]
      }
    }
    entities.set(id, entity)
  }
  const byName = new Map<string, Array<[number, number, number]>>()
  const styleTypes = new Set(['PRESENTATION_STYLE_ASSIGNMENT', 'PRESENTATION_STYLE_BY_CONTEXT',
    'SURFACE_STYLE_USAGE', 'SURFACE_SIDE_STYLE', 'SURFACE_STYLE_FILL_AREA',
    'FILL_AREA_STYLE', 'FILL_AREA_STYLE_COLOUR', 'SURFACE_STYLE_RENDERING', 'COLOUR_RGB'])
  function colorOf(id: string, seen = new Set<string>()): [number, number, number] | undefined {
    if (seen.has(id)) return undefined
    seen.add(id)
    const entity = entities.get(id)
    if (!entity || !styleTypes.has(entity.type)) return undefined
    if (entity.rgb) return entity.rgb
    for (const ref of entity.refs) {
      const rgb = colorOf(ref, seen)
      if (rgb) return rgb
    }
  }
  const targetTypes = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'SHELL_BASED_SURFACE_MODEL',
    'GEOMETRIC_SET', 'ADVANCED_BREP_SHAPE_REPRESENTATION'])
  const namedTargets = new Map<string, number>()
  for (const entity of entities.values()) {
    if (entity.name && targetTypes.has(entity.type)) {
      namedTargets.set(entity.name, (namedTargets.get(entity.name) ?? 0) + 1)
    }
  }
  for (const entity of entities.values()) {
    if (entity.type !== 'STYLED_ITEM' && entity.type !== 'OVER_RIDING_STYLED_ITEM') continue
    // The styled representation item follows the presentation assignments.
    const target = entities.get(entity.refs[1])
    if (!target?.name || !targetTypes.has(target.type)) continue
    const rgb = colorOf(entity.refs[0])
    if (rgb) byName.set(target.name, [...(byName.get(target.name) ?? []), rgb])
  }
  return new Map([...byName].flatMap(([name, colors]) =>
    namedTargets.get(name) === 1 && colors.every(c => c.every((v, i) => v === colors[0][i]))
      ? [[name, colors[0]]] : []))
}
