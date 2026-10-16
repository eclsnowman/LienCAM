import { textFor } from '../../../i18n'
const probeText = textFor('probing-screens')

// WO-2166: the Calibrate routine's references, kept per machine - each a name,
// a kind (outside: gauge pin / round boss; inside: ring gauge / known bore)
// and an exact diameter - and the one last used, which the screen preselects.
//
// Held for the app session, not across a reload: a lasting per-machine record
// needs a registered storage key (src/store/persistedKeys.ts), outside this
// order's grant. A disconnect does not drop them (the probing session's
// touches are, the references are the operator's list).

import { create } from 'zustand'
import type { CalibrationReference, CalibrationReferenceKind } from '../../../lib/machine/probeCalibration'

/** Every machine's list starts with the order's own example. */
export const FIRST_REFERENCE: CalibrationReference = { id: 'ref-1', name: probeText('calibrationReferences1'), kind: 'outside', diameterMm: 25 }

interface MachineReferences {
  list: CalibrationReference[]
  lastUsedId: string
}

interface CalibrationReferencesState {
  byMachine: Record<string, MachineReferences>
}

const useCalibrationReferencesStore = create<CalibrationReferencesState>(() => ({ byMachine: {} }))

const FIRST: MachineReferences = { list: [FIRST_REFERENCE], lastUsedId: FIRST_REFERENCE.id }

function recordFor(state: CalibrationReferencesState, machineId: string): MachineReferences {
  return state.byMachine[machineId] ?? FIRST
}

function write(machineId: string, change: (record: MachineReferences) => MachineReferences): void {
  useCalibrationReferencesStore.setState((s) => ({ byMachine: { ...s.byMachine, [machineId]: change(recordFor(s, machineId)) } }))
}

/** The machine's references and the one selected (the last used). */
export function useCalibrationReferences(machineId: string): { list: CalibrationReference[]; selected: CalibrationReference } {
  const record = useCalibrationReferencesStore((s) => recordFor(s, machineId))
  return { list: record.list, selected: record.list.find((r) => r.id === record.lastUsedId) ?? record.list[0] }
}

export function selectCalibrationReference(machineId: string, id: string): void {
  write(machineId, (r) => (r.list.some((ref) => ref.id === id) ? { ...r, lastUsedId: id } : r))
}

export function editCalibrationReference(
  machineId: string,
  id: string,
  patch: Partial<Pick<CalibrationReference, 'name' | 'kind' | 'diameterMm'>>,
): void {
  write(machineId, (r) => ({ ...r, list: r.list.map((ref) => (ref.id === id ? { ...ref, ...patch } : ref)) }))
}

/** Adds a reference (a copy of the selected one, to edit) and selects it. */
export function addCalibrationReference(machineId: string, from: { kind: CalibrationReferenceKind; diameterMm: number }): void {
  write(machineId, (r) => {
    let n = r.list.length + 1
    while (r.list.some((ref) => ref.id === `ref-${n}`)) n++
    const ref: CalibrationReference = { id: `ref-${n}`, name: probeText('calibrationReferences2', { value1: String(n) }), kind: from.kind, diameterMm: from.diameterMm }
    return { list: [...r.list, ref], lastUsedId: ref.id }
  })
}

/** Removes a reference; the list keeps at least one (the screen offers Remove
 *  only when there are two or more). */
export function removeCalibrationReference(machineId: string, id: string): void {
  write(machineId, (r) => {
    if (r.list.length <= 1) return r
    const list = r.list.filter((ref) => ref.id !== id)
    return { list, lastUsedId: r.lastUsedId === id ? list[0].id : r.lastUsedId }
  })
}

export function __resetCalibrationReferencesForTest(): void {
  useCalibrationReferencesStore.setState({ byMachine: {} })
}
