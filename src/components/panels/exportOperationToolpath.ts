import { useCamStore } from '../../store'
import { saveFile } from '../../lib/saveFile'
import { toolpathDxf, toolpathSvg, type ToolpathExportFormat } from '../../lib/cam/toolpathExport'

/** Shared production action used by both export controls. Saved paths remain
 * exportable regardless of posting eligibility; no machine/post is required. */
export async function exportOperationToolpath(setupId: string, operationId: string, format: ToolpathExportFormat): Promise<string | null> {
  const find = () => useCamStore.getState().project.setups
    .find(setup => setup.id === setupId)?.operations.find(op => op.id === operationId)
  let operation = find()
  if (!operation) throw new Error('Operation no longer exists')
  if (!operation.toolpathMoves?.length) {
    await useCamStore.getState().computeOperationToolpath(setupId, operationId)
    operation = find()
  }
  if (!operation?.toolpathMoves?.length) throw new Error(operation?.errorMessage || 'Operation has no toolpath to export')
  const name = Array.from(operation.name, char => char.charCodeAt(0) < 32 ? '_' : char).join('')
    .replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || 'toolpath'
  return saveFile(`${name}.${format}`, format === 'dxf'
    ? toolpathDxf(operation.toolpathMoves) : toolpathSvg(operation.toolpathMoves),
  format === 'dxf' ? 'application/dxf' : 'image/svg+xml')
}
