// WO-2859 (audit FAIL 2, astra 2026-10-16): an STL edge-chain id (WO-244) is
// content-derived, so two copies of one STL carry the SAME chain ids. Under
// All Parts the picked id alone cannot say which copy the operator ticked;
// the operation's `meshChainSources` (WO-251/258) names the part instances
// that were picked, and this is the one rule the dialog and compute read it by.
//
// A chain with a binding is cut only on the parts its binding names. A chain
// with no binding (picked from the viewport, which reports an id but not the
// part, or "All loops") is cut on every part that carries it - which is also
// what the viewport highlights for that id.

export type MeshChainSourceBinding = { geometryId: string; geometryName: string }
export type MeshChainSources = Record<string, MeshChainSourceBinding[]>

type ChainSource = {
  id: string
  type: string
  format?: string
  loops?: Array<{ id: string }>
}

export function isMeshChainId(loopId: string): boolean {
  return loopId.startsWith('mec:')
}

export function isStlChainSource(source: { type: string; format?: string }): boolean {
  return source.type === 'mesh' && source.format === 'stl'
}

/** Did the operator pick chain `chainId` on part `geometryId`? */
export function isMeshChainInstancePicked(
  loopIds: readonly string[],
  bindings: MeshChainSources | undefined,
  chainId: string,
  geometryId: string,
): boolean {
  if (!loopIds.includes(chainId)) return false
  const bound = bindings?.[chainId]
  return !bound?.length || bound.some((binding) => binding.geometryId === geometryId)
}

/** Compute: drop each bound chain from the parts its binding does not name.
 *  Sources are returned unchanged (same objects) when nothing is dropped. */
export function narrowToPickedMeshChainInstances<G extends ChainSource>(
  sources: G[],
  bindings: MeshChainSources | undefined,
): G[] {
  if (!bindings || Object.keys(bindings).length === 0) return sources
  return sources.map((source) => {
    if (!isStlChainSource(source) || !source.loops) return source
    const loops = source.loops.filter((loop) => {
      const bound = isMeshChainId(loop.id) ? bindings[loop.id] : undefined
      return !bound?.length || bound.some((binding) => binding.geometryId === source.id)
    })
    return loops.length === source.loops.length ? source : { ...source, loops }
  })
}

// WO-2859 (audit FAIL 3, astra 2026-10-16): the selection used to live in two
// parallel fields that every writer had to keep in step - `loopIds` and
// `meshChainSources` - and a Source change cleared only the first, so a
// discarded instance pick came back on the next tick. The truth is now ONE
// list of picks: a loop id, on one part instance or (no instance) on every
// part carrying it. `loopSelectionPicks` reads it from params,
// `withLoopSelection` is the one writer that derives both fields from it, and
// `normalizeLoopSelection` (every Pocket/Adaptive/Contour draft write in the
// dialog runs it) means no binding can outlive its pick.

export type LoopSelectionPick = { loopId: string; instance?: MeshChainSourceBinding }
type LoopSelectionParams = { geometryId?: string; loopIds?: string[] }
type WithBindings = { meshChainSources?: MeshChainSources }

const ALL_PARTS = '__all__'

/** The picks params hold. A binding counts only for a chain id that is in
 *  `loopIds`, and only under All Parts - the one place a pick names a part. */
export function loopSelectionPicks(params: LoopSelectionParams): LoopSelectionPick[] {
  const bindings = params.geometryId === ALL_PARTS ? (params as WithBindings).meshChainSources : undefined
  return (params.loopIds ?? []).flatMap((loopId): LoopSelectionPick[] => {
    const bound = isMeshChainId(loopId) ? bindings?.[loopId] : undefined
    return bound?.length ? bound.map((instance) => ({ loopId, instance })) : [{ loopId }]
  })
}

/** Write `picks` into params: `loopIds` in pick order, and a binding for each
 *  chain whose every pick names an instance (an unbound pick = every copy). */
export function withLoopSelection<T extends LoopSelectionParams>(
  params: T,
  picks: readonly LoopSelectionPick[],
): T {
  const loopIds: string[] = []
  const bound = new Map<string, MeshChainSourceBinding[] | null>()
  for (const { loopId, instance } of picks) {
    if (!bound.has(loopId)) {
      loopIds.push(loopId)
      bound.set(loopId, [])
    }
    const instances = bound.get(loopId)
    if (instances === null) continue
    if (!instance || params.geometryId !== ALL_PARTS || !isMeshChainId(loopId)) bound.set(loopId, null)
    else if (!instances!.some((b) => b.geometryId === instance.geometryId)) instances!.push(instance)
  }
  const meshChainSources: MeshChainSources = {}
  for (const [loopId, instances] of bound) if (instances?.length) meshChainSources[loopId] = instances
  const next = { ...params, loopIds } as T & WithBindings
  if (Object.keys(meshChainSources).length > 0) next.meshChainSources = meshChainSources
  else delete next.meshChainSources
  return next
}

/** Drop every binding that no pick carries. Returns `params` itself when it
 *  already holds none (the common case), so an untouched draft keeps identity. */
export function normalizeLoopSelection<T extends LoopSelectionParams>(params: T): T {
  const bindings = (params as WithBindings).meshChainSources
  if (bindings === undefined) return params
  const loopIds = params.loopIds ?? []
  const consistent = params.geometryId === ALL_PARTS &&
    Object.entries(bindings).every(([loopId, instances]) => instances.length > 0 && loopIds.includes(loopId))
  if (consistent) return params
  const next = { ...params } as T & WithBindings
  const kept: MeshChainSources = {}
  if (params.geometryId === ALL_PARTS) {
    for (const [loopId, instances] of Object.entries(bindings)) {
      if (instances.length > 0 && loopIds.includes(loopId)) kept[loopId] = instances
    }
  }
  if (Object.keys(kept).length > 0) next.meshChainSources = kept
  else delete next.meshChainSources
  return next
}
