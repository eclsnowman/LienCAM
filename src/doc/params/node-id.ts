// Parameter node-id convention (DOC lane, WO DOC-4).
//
// A parameter's FeatureDag node id is derived, never minted/random, so it is
// stable across sessions/save-load and collides with neither feature ids
// ("F12"), sketch ids ("S3"), nor anything else sharing the dag's single id
// namespace (DagNodeInput.id: "Stable, caller-assigned node id").

const PREFIX = 'param:'

export function paramNodeId(name: string): string {
  return `${PREFIX}${name}`
}

/** Inverse of paramNodeId; undefined if `id` is not a parameter node id. */
export function paramNameFromNodeId(id: string): string | undefined {
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : undefined
}
