// useControlJogKeys - keyboard jogging scoped to the Control workspace
// (MACHINE-CONTROL plan, stage 5).
//
// Deliberately its OWN hook, NOT a widening of useGlobalShortcuts: that
// hook's guard is cam-workspace-only by hard-won design (WO INT-13C), and jog
// keys are a different, more dangerous key space - they move a physical
// machine. Guard: Control workspace active, no modal open, no text input
// focused, connection live, machine idle/jogging.
//
// Bindings (sender convention): Arrow keys = X/Y, PageUp/PageDown = Z.
// Each non-repeat keydown sends ONE step jog (predictable, bounded motion);
// key repeat is ignored so holding a key cannot queue unbounded travel.

import { useEffect } from 'react'
import { useCamStore } from '../store'
import { useMachineControl } from '../store/machineControlStore'
import { useUiPrefs } from '../store/uiPrefs'
import { getMachineController, type JogAxis } from '../lib/machine/machineSession'

const KEY_TO_JOG: Record<string, { axis: JogAxis; sign: 1 | -1 }> = {
  ArrowLeft: { axis: 'X', sign: -1 },
  ArrowRight: { axis: 'X', sign: 1 },
  ArrowUp: { axis: 'Y', sign: 1 },
  ArrowDown: { axis: 'Y', sign: -1 },
  PageUp: { axis: 'Z', sign: 1 },
  PageDown: { axis: 'Z', sign: -1 },
}

// A dialog is open when the store says so OR one is on screen. Some dialogs
// (macro editor, machine actions) are local state and never set activeModal;
// every dialog draws a `.modal-backdrop`, so that is the one test for all of
// them (WO-1706 review: an arrow key reordering macros jogged the machine).
export function dialogOpen(): boolean {
  if (useCamStore.getState().activeModal) return true
  return typeof document !== 'undefined' && document.querySelector('.modal-backdrop') !== null
}

export function jogKeysAllowed(): boolean {
  const cam = useCamStore.getState()
  if (cam.workspace !== 'control' || dialogOpen()) return false
  const mc = useMachineControl.getState()
  if (mc.connectionPhase !== 'connected') return false
  if (mc.machineState !== 'idle' && mc.machineState !== 'jog') return false
  const el = document.activeElement
  if (el instanceof HTMLElement) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable)
      return false
  }
  return true
}

export function useControlJogKeys(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const binding = KEY_TO_JOG[e.key]
      if (!binding) return
      if (!jogKeysAllowed()) return
      e.preventDefault()
      const prefs = useUiPrefs.getState()
      getMachineController().jog(
        binding.axis,
        binding.sign * prefs.machineJogStepMm,
        prefs.machineJogFeedMmMin,
      )
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
