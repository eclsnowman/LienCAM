// WO-2899: read the same defaults as the dialogs; never copy their parameter values.
import type { OperationType } from '../../types'
import * as ui from '../../components/modals/newOperationModalDefaults'
import { DEFAULT_ADAPTIVE3D_PARAMS } from '../../cam3d/integration/adaptive3dOperation'
import { DEFAULT_PARALLEL3D_PARAMS } from '../../cam3d/integration/parallel3dOperation'
import { DEFAULT_PENCIL3D_PARAMS } from '../../cam3d/integration/pencil3dOperation'
import { DEFAULT_WATERLINE_PARAMS } from '../../cam3d/integration/waterline3dOperation'
import { DEFAULT_SCALLOP3D_PARAMS } from '../../cam3d/integration/scallop3dOperation'
import { DEFAULT_STEEP_SHALLOW3D_PARAMS } from '../../cam3d/integration/steepShallow3dOperation'
import { defaultPatternParams } from '../../kernel/parameterDefaults'

export const ALPHA3_DEFAULTS: Record<OperationType, object> = {
  face: ui.defaultFaceParams, pocket_2d: ui.defaultPocketParams,
  adaptive_clearing_2d: ui.defaultACParams, contour_2d: ui.defaultContourParams,
  drill: ui.defaultDrillParams, bore: ui.defaultBoreParams,
  thread_mill: ui.defaultThreadMillParams, chamfer: ui.defaultChamferParams,
  engrave: ui.defaultEngraveParams, vcarve: ui.defaultVCarveParams,
  pattern: defaultPatternParams,
  adaptive_3d: DEFAULT_ADAPTIVE3D_PARAMS, parallel_3d: DEFAULT_PARALLEL3D_PARAMS,
  pencil_3d: DEFAULT_PENCIL3D_PARAMS, waterline_3d: DEFAULT_WATERLINE_PARAMS,
  scallop_3d: DEFAULT_SCALLOP3D_PARAMS, steep_shallow_3d: DEFAULT_STEEP_SHALLOW3D_PARAMS,
}
export const alpha3DialogDefaults = {
  heights: ui.defaultHeights, passes: ui.defaultPasses, linking: ui.defaultLinking,
}

// Geometry/tool/thread identity describes the task, rather than tuning the engine.
// Keep these when applying defaults so a defaults run still machines the SAME pick.
const TASK_KEYS = new Set([
  'geometryId', 'loopIds', 'faceIds', 'edgeIds', 'loopSides', 'geometrySource',
  'threadKind', 'majorDiameter', 'pitch', 'threadDepth', 'externalReference',
  'cylinderSelection', 'cylinderSelections',
])
export function defaultParams(type: OperationType, declared: Record<string, unknown>): Record<string, unknown> {
  return structuredClone({ ...ALPHA3_DEFAULTS[type],
    ...Object.fromEntries(Object.entries(declared).filter(([key]) => TASK_KEYS.has(key))),
  })
}
