import { operationGenerationIsCurrent } from '../cam/generationFingerprint'
import { selectEnabledOperations } from '../cam/operationSuppression'
import { useCamStore } from '../../store'
import type { ImportedGeometry, Operation, Project, Setup } from '../../types'

/**
 * The only renderer commands an external agent may reach in this slice.
 *
 * This list is deliberately data, not a reflection over the CAM store: adding a
 * store action cannot accidentally turn it into an agent command. Machine
 * motion, model internals, and store mutation are outside this boundary.
 */
export const AGENT_COMMAND_ALLOW_LIST = Object.freeze([
  'project_summary',
  'feature_details',
  'tool_library',
  'machine_limits',
] as const)

export type AgentCommandName = (typeof AGENT_COMMAND_ALLOW_LIST)[number]

export interface FeatureDetailsInput {
  id: string
}

export type AgentFeatureKind =
  | 'geometry_folder'
  | 'model_item'
  | 'geometry'
  | 'body'
  | 'layer'
  | 'sketch'
  | 'stock'
  | 'nest'
  | 'setup'
  | 'operation_folder'
  | 'operation'

export interface AgentFeatureDetails {
  kind: AgentFeatureKind
  id: string
  name: string
  payload: object
}

function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function liveProject(state: ReturnType<typeof useCamStore.getState>): Project {
  // The root tool slice is the live source of truth. Project.toolLibrary is a
  // serialization snapshot, so freshness checks must see the same tools as the
  // Design Tree, operation Properties, and post paths.
  return { ...state.project, toolLibrary: state.toolLibrary }
}

function operationSummary(project: Project, setup: Setup, operation: Operation) {
  return {
    id: operation.id,
    name: operation.name,
    type: operation.type,
    enabled: operation.enabled,
    status: operation.status,
    toolId: operation.toolId,
    geometrySelections: operation.geometrySelections,
    generationCurrent: operationGenerationIsCurrent(project, setup, operation),
    ...(operation.errorMessage === undefined ? {} : { errorMessage: operation.errorMessage }),
    ...(operation.modelReferenceNote === undefined ? {} : { modelReferenceNote: operation.modelReferenceNote }),
    ...(operation.diagnostics === undefined ? {} : { diagnostics: operation.diagnostics }),
    ...(operation.estimatedCutTimeMs === undefined ? {} : { estimatedCutTimeMs: operation.estimatedCutTimeMs }),
    ...(operation.estimatedCutTimeMsError === undefined
      ? {}
      : { estimatedCutTimeMsError: operation.estimatedCutTimeMsError }),
  }
}

function bodySummary(geometry: ImportedGeometry) {
  if (!geometry.modelBody) return undefined
  const display = geometry.modelBody.display
  return {
    id: geometry.modelBody.ref.bodyId,
    name: geometry.name,
    geometryId: geometry.id,
    modelItemId: geometry.modelItemId,
    lineageId: geometry.modelBody.ref.lineageId,
    version: geometry.modelBody.ref.version,
    stableIds: geometry.modelBody.ref.stableIds,
    boundingBox: geometry.boundingBox,
    faceCount: display?.faceIds?.length ?? geometry.faceCount,
    edgeCount: display?.edgeIds?.length,
    loaded: geometry.loaded,
  }
}

/** The Design Tree and Properties-panel view of the live project. */
export function project_summary() {
  const state = useCamStore.getState()
  const project = liveProject(state)
  const usedToolIds = new Set(
    project.setups.flatMap((setup) => setup.operations.map((operation) => operation.toolId)),
  )

  return jsonCopy({
    project: {
      id: project.id,
      name: project.name,
      version: project.version,
      schemaVersion: project.schemaVersion,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      activeSetupId: project.activeSetupId,
      activeOperationId: project.activeOperationId,
    },
    tree: {
      geometryFolders: project.geometryFolders ?? [],
      features: project.geometry.map((geometry) => ({
        id: geometry.id,
        name: geometry.name,
        filename: geometry.filename,
        type: geometry.type,
        format: geometry.format,
        loaded: geometry.loaded,
        hidden: geometry.hidden === true,
        locked: geometry.locked === true,
        workholding: geometry.workholding === true,
        folderId: geometry.folderId ?? null,
        stockId: geometry.stockId ?? null,
        boundingBox: geometry.boundingBox,
        projectionStale: geometry.projectionStale === true,
        layers: (geometry.layers2d ?? []).map((layer) => ({
          id: layer.id,
          name: layer.name,
          visible: layer.visible,
          locked: layer.locked === true,
          derived: layer.derived === true,
          sectionStale: layer.sectionStale === true,
          projectionPlane: layer.projectionPlane,
        })),
        sketches: (geometry.sketches ?? []).map((sketch) => ({
          id: sketch.id,
          layerId: sketch.layerId,
          ownerGeometryId: sketch.ownerGeometryId ?? geometry.id,
          solveStatus: sketch.solveStatus,
        })),
        body: bodySummary(geometry),
      })),
      modelItems: project.modelItems ?? [],
      bodies: project.geometry.flatMap((geometry) => {
        const body = bodySummary(geometry)
        return body === undefined ? [] : [body]
      }),
      stocks: project.stocks ?? [],
      nests: project.nests ?? [],
      setups: project.setups.map((setup) => ({
        id: setup.id,
        name: setup.name,
        wcs: setup.wcs,
        stock: setup.stock,
        flipOf: setup.flipOf,
        notes: setup.notes,
        operationFolders: setup.operationFolders ?? [],
        enabledOperationIds: selectEnabledOperations(setup.operations, null).map((operation) => operation.id),
        operations: setup.operations.map((operation) => operationSummary(project, setup, operation)),
      })),
    },
    toolsInUse: state.toolLibrary.filter((tool) => usedToolIds.has(tool.id)),
    toolpathBatch: state.toolpathBatch,
    consoleEvents: state.consoleEvents,
  })
}

function geometryPayload(geometry: ImportedGeometry): Record<string, unknown> {
  const { modelBody, ...payload } = geometry
  if (!modelBody) return payload
  const { display, ...modelBodyWithoutDisplay } = modelBody
  return {
    ...payload,
    modelBody: {
      ...modelBodyWithoutDisplay,
      ...(display === undefined
        ? {}
        : {
            display: {
              bbox: display.bbox,
              faceIds: display.faceIds,
              edgeIds: display.edgeIds,
              triangleCount: Math.floor(display.indices.length / 3),
            },
          }),
    },
  }
}

/** One Design Tree node, with the same persisted payload and result words its Properties panel reads. */
export function feature_details(input: FeatureDetailsInput): AgentFeatureDetails | null {
  const state = useCamStore.getState()
  const project = liveProject(state)
  const { id } = input

  const geometryFolder = project.geometryFolders?.find((folder) => folder.id === id)
  if (geometryFolder) return jsonCopy({ kind: 'geometry_folder', id, name: geometryFolder.name, payload: geometryFolder })

  const modelItem = project.modelItems?.find((item) => item.id === id)
  if (modelItem) return jsonCopy({ kind: 'model_item', id, name: modelItem.name, payload: modelItem })

  for (const geometry of project.geometry) {
    if (geometry.id === id) {
      return jsonCopy({ kind: 'geometry', id, name: geometry.name, payload: geometryPayload(geometry) })
    }
    if (geometry.modelBody?.ref.bodyId === id) {
      return jsonCopy({ kind: 'body', id, name: geometry.name, payload: geometryPayload(geometry) })
    }
    const layer = geometry.layers2d?.find((candidate) => candidate.id === id)
    if (layer) {
      return jsonCopy({
        kind: 'layer', id, name: layer.name,
        payload: { geometryId: geometry.id, geometryName: geometry.name, ...layer },
      })
    }
    const sketch = geometry.sketches?.find((candidate) => candidate.id === id)
    if (sketch) {
      return jsonCopy({
        kind: 'sketch', id, name: layerName(geometry, sketch.layerId),
        payload: { geometryId: geometry.id, geometryName: geometry.name, ...sketch },
      })
    }
  }

  const stock = project.stocks?.find((candidate) => candidate.id === id)
  if (stock) return jsonCopy({ kind: 'stock', id, name: stock.name, payload: stock })

  const nest = project.nests?.find((candidate) => candidate.id === id)
  if (nest) return jsonCopy({ kind: 'nest', id, name: nest.name, payload: nest })

  for (const setup of project.setups) {
    if (setup.id === id) return jsonCopy({ kind: 'setup', id, name: setup.name, payload: setup })
    const folder = setup.operationFolders?.find((candidate) => candidate.id === id)
    if (folder) {
      return jsonCopy({
        kind: 'operation_folder', id, name: folder.name,
        payload: { setupId: setup.id, setupName: setup.name, ...folder },
      })
    }
    const operation = setup.operations.find((candidate) => candidate.id === id)
    if (operation) {
      const { toolpathMoves: _moves, ...payload } = operation
      return jsonCopy({
        kind: 'operation', id, name: operation.name,
        payload: {
          setupId: setup.id,
          setupName: setup.name,
          ...payload,
          generationCurrent: operationGenerationIsCurrent(project, setup, operation),
        },
      })
    }
  }

  return null
}

function layerName(geometry: ImportedGeometry, layerId: string): string {
  return geometry.layers2d?.find((layer) => layer.id === layerId)?.name ?? 'Sketch'
}

/** The same three live root slices shown by the Tool Library modal. */
export function tool_library() {
  const state = useCamStore.getState()
  return jsonCopy({
    libraries: state.toolLibraries,
    tools: state.toolLibrary,
    holders: state.holders,
  })
}

/** A detached, recursively frozen copy of the active project's machine definition. */
export function machine_limits() {
  return deepFreeze(jsonCopy(useCamStore.getState().project.machine))
}

export const liencamCommands = Object.freeze({
  project_summary,
  feature_details,
  tool_library,
  machine_limits,
})

export type LiencamCommands = typeof liencamCommands
