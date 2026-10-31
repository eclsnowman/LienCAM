// WO-3275 (UI M2 Wave 0): the New UI switch. OFF by default; while off the shipped UI is exactly
// as before. It persists on its own key here, not in uiPrefs.ts (held by another order), and the
// Settings > Appearance row that flips it comes in a follow-up once that file is free.
//
// Three ways to set it:
//   - code: setNewUi(true | false), persisted (the future Settings row calls this);
//   - dev query flag: ?newui=1 or ?newui=0 overrides the stored value for this page load only,
//     so a test drive never strands a later plain load in the new shell;
//   - nothing: off.
import { useSyncExternalStore } from 'react'
import { PERSISTED_USER_DATA_REGISTRY, readRegisteredLocalData, writeRegisteredLocalData } from '../store/persistedKeys'

export const NEW_UI_STORAGE_KEY = PERSISTED_USER_DATA_REGISTRY.newUiSwitch.key
export const NEW_UI_QUERY_FLAG = 'newui'
export const NEW_UI_DEFAULT = false

type Listener = () => void
const listeners = new Set<Listener>()
let queryOverride: boolean | undefined
// The choice made this session when storage refused the write (private mode); cleared once a write works.
let sessionChoice: boolean | undefined

function readStored(): boolean {
  try { return readRegisteredLocalData('newUiSwitch') === '1' } catch { return NEW_UI_DEFAULT }
}

/** The query flag's value in a location search string: true, false, or undefined when absent
 *  or not 1/0/true/false/on/off. */
export function parseNewUiQuery(search: string): boolean | undefined {
  const raw = new URLSearchParams(search).get(NEW_UI_QUERY_FLAG)
  if (raw === null) return undefined
  const v = raw.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'off') return false
  return undefined
}

/** Apply a dev query flag for this page load (not persisted). Call once at startup. */
export function applyNewUiQuery(search: string): void {
  const flag = parseNewUiQuery(search)
  if (flag === undefined || flag === queryOverride) return
  queryOverride = flag
  for (const l of listeners) l()
}

export function isNewUiOn(): boolean {
  return queryOverride ?? sessionChoice ?? readStored()
}

/** Set and persist the switch (a query flag for this page load still wins until reload). */
export function setNewUi(on: boolean): void {
  const value = on ? '1' : '0'
  try {
    writeRegisteredLocalData('newUiSwitch', value)
    // No usable storage is the same as a denied one: the choice holds for this session.
    sessionChoice = readRegisteredLocalData('newUiSwitch') === value ? undefined : on
  } catch { sessionChoice = on } // storage denied: the choice holds for this session
  for (const l of listeners) l()
}

export function subscribeNewUi(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** React: the switch's current value, re-rendering when it changes. */
export function useNewUi(): boolean {
  return useSyncExternalStore(subscribeNewUi, isNewUiOn, () => NEW_UI_DEFAULT)
}

/** Tests only: forget a query override. */
export function resetNewUiQueryForTests(): void {
  queryOverride = undefined
  sessionChoice = undefined
}
