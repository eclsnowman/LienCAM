import { textFor, useText } from '../../i18n'
const words = textFor('setup-stock-tools-machine-post')
// WO-2198 (workholding assemblies, slice 6): the Setup-screen controls that
// use a vise or clamp again (lib/workholding/reuse.ts).
//
//   - Place another (vise Properties): another vise from the same definition,
//     beside this one at the same opening, in the active setup; it is then
//     selected so its own position and opening can be set.
//   - Export (vise and clamp Properties): the definition saved to a
//     "<name>.workholding.json" file.
//   - Import (the Geometry "+" in the tree takes that file too): the file's
//     vise or clamp becomes this project's own; a vise is placed where it sat
//     when exported, in the active setup, and selected.
//
// Each is one store action, so one undo step. The console says what was done;
// a file that is not a vise or clamp file only says it could not be read. No
// refusal, warning, confirm or disabled control (rule 11).

import { Copy, Download } from 'lucide-react'
import { useCamStore } from '../../store'
import type { Vec3 } from '../../types'
import { loadCachedSTL } from '../../lib/stlCache'
import { WORKHOLDING_FILE_SUFFIX } from '../../lib/workholding/reuse'
import { applyViseDrawPoses } from './viseViewport'
import { applyClampDrawings, type ClampDrawTarget } from './clampViewport'
import { selectClamp } from './ClampEditor'

type VpHandle = ClampDrawTarget & {
  setSTLVisible(id: string, visible: boolean): void
}
const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle | undefined) ?? null

function say(message: string, severity: 'info' | 'warning' = 'info') {
  useCamStore.getState().addConsoleEvent({ severity, source: 'workholding', message })
}

/** True for a file the tree's import should read as a vise or clamp. */
export function isWorkholdingFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith(WORKHOLDING_FILE_SUFFIX) || lower.endsWith('.json')
}

/** Place another vise from `instanceId`'s definition and select it. Returns its id. */
export function placeAnotherVise(instanceId: string): string | null {
  const id = useCamStore.getState().placeAnotherWorkholding(instanceId)
  if (id) selectClamp(id)
  return id
}

/** Save the definition `instanceId` places to a file (a browser download). */
export async function exportWorkholdingToFile(instanceId: string): Promise<boolean> {
  const out = await useCamStore.getState().exportWorkholdingFile(instanceId)
  if (!out) return false
  const url = URL.createObjectURL(new Blob([out.text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = out.fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  say(words("WorkholdingReuse.exported_to", { value1: out.fileName }))
  for (const notice of out.notices) say(words("WorkholdingReuse.export", { value1: notice }))
  return true
}

/**
 * Read a vise or clamp file into this project. Its shape rows are put in the
 * scene the way an imported STL is, then drawn where the vise puts them.
 * Returns the placed vise's id, the definition id for a clamp, or null when
 * the file could not be read.
 */
export async function importWorkholdingFromFile(file: File): Promise<string | null> {
  const text = await file.text()
  const result = await useCamStore.getState().importWorkholdingFile(text)
  if (!result) {
    say(words("WorkholdingReuse.could_not_be_read_as_a_vise", { value1: file.name }))
    return null
  }
  const { project } = useCamStore.getState()
  const definition = project.workholding?.definitions.find((d) => d.id === result.definitionId)
  const vp = getVp()
  if (vp) {
    for (const id of result.rowIds) {
      const row = project.geometry.find((g) => g.id === id)
      const bytes = row ? await loadCachedSTL(id).catch(() => null) : null
      if (!row || !bytes) continue
      try {
        await vp.addSTL(bytes, id, row.name, row.position as Vec3, row.rotation as Vec3)
        vp.setPartWorkholding(id, true)
      } catch (err) {
        console.error(`WO-2198: the imported shape "${row.name}" could not be drawn:`, err)
      }
    }
    applyViseDrawPoses(vp)
    await applyClampDrawings(vp)
  }
  const name = definition?.name ?? words("WorkholdingReuse.workholding")
  if (result.instanceId) {
    selectClamp(result.instanceId)
    say(words("WorkholdingReuse.imported_the_vise_from", { value1: name, value2: file.name }))
    return result.instanceId
  }
  say(words("WorkholdingReuse.imported_the_clamp_from_place_it_on", { value1: name, value2: file.name }))
  return result.definitionId
}

export function PlaceAnotherButton({ instanceId }: { instanceId: string }) {
  const words = useText('setup-stock-tools-machine-post')
  return (
    <button
      type="button"
      className="props-btn"
      data-testid="vise-place-another"
      data-tooltip={words("WorkholdingReuse.another_vise_from_this_one_its_own")}
      onClick={() => { placeAnotherVise(instanceId) }}
    ><Copy size={11} />{words("WorkholdingReuse.place_another")}</button>
  )
}

export function ExportWorkholdingButton({ instanceId, testId }: { instanceId: string; testId: string }) {
  const words = useText('setup-stock-tools-machine-post')
  return (
    <button
      type="button"
      className="props-btn"
      data-testid={testId}
      data-tooltip={words("WorkholdingReuse.save_it_to_a_file_import_on")}
      onClick={() => { void exportWorkholdingToFile(instanceId) }}
    ><Download size={11} />{words("WorkholdingReuse.export_2")}</button>
  )
}
