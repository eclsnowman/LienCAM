// WO-413 - the generalized help hotlink and the return-to-context rule.
//
// Operator (2026-08-20): "closing help should return you to where you were with
// currently editing values still in place. This should be generalized."
//
// Help is a modal over the app (activeModal === 'help'), and openModal('help')
// REPLACES the active modal - so Help opened from inside Post Process would
// unmount Post Process and lose its edits, and the store's closeModal() also
// clears the edit payloads, so a "re-open the previous modal" would come back
// blank. The smallest honest mechanism is therefore: when another modal is
// active, open Help as an OVERLAY (this tiny store's `overlay` flag) and leave
// activeModal alone - the modal underneath stays mounted with its state
// untouched; closing Help just clears the flag. When no modal is active, Help
// opens exactly as the toolbar opens it. Either way nothing else changes, so
// "where you were" is simply still there.
//
// `requested` carries the topic (and optional anchor) a hotlink asked for;
// HelpCenterModal consumes it when it opens.

import { create } from 'zustand'
import { useCamStore } from '../store'
import { i18n } from '../i18n'
import { setHelpTextLookup } from './topics/catalog'

// The same active language and regional/English fallback as the UI catalogs.
// Read plain resources: Help prose can contain braces, G-code and decimals,
// so interpolation and number formatting must never alter these strings.
setHelpTextLookup((key, english) => {
  for (const language of i18n.languages) {
    if (language === 'en') return english
    const translated: unknown = i18n.getResource(language, 'help', key)
    if (typeof translated === 'string' && translated !== '') return translated
  }
  return english
})

export interface HelpRequest {
  topicId: string
  anchor: string | null
  /** Monotonic, so a second request for the same topic still re-selects it. */
  nonce: number
}

interface HelpOpenState {
  /** The topic a hotlink asked for; null when Help was opened from the chrome. */
  requested: HelpRequest | null
  /** True while Help is shown OVER another modal (see the header comment). */
  overlay: boolean
  request: (topicId: string, anchor?: string | null) => void
  setOverlay: (overlay: boolean) => void
  clearRequest: () => void
}

let nonce = 0

export const useHelpOpen = create<HelpOpenState>()((set) => ({
  requested: null,
  overlay: false,
  request: (topicId, anchor = null) =>
    set({ requested: { topicId, anchor, nonce: ++nonce } }),
  setOverlay: (overlay) => set({ overlay }),
  clearRequest: () => set({ requested: null }),
}))

export const HELP_MODAL_IDS = ['help', 'help-errors'] as const

export function isHelpModalId(id: string | null): boolean {
  return id === 'help' || id === 'help-errors'
}

/**
 * Open the Help Center AT a topic (optionally scrolled to an anchor inside
 * it). Works from anywhere: a panel, a station card, or inside another modal
 * (the other modal stays open underneath and is still there when Help closes).
 */
export function openHelpTopic(topicId: string, anchor?: string | null): void {
  useHelpOpen.getState().request(topicId, anchor ?? null)
  const cam = useCamStore.getState()
  if (cam.activeModal && !isHelpModalId(cam.activeModal)) {
    useHelpOpen.getState().setOverlay(true)
    return
  }
  useHelpOpen.getState().setOverlay(false)
  cam.openModal('help')
}

/** Close Help however it was opened: clear the overlay, or close the modal. */
export function closeHelp(): void {
  const help = useHelpOpen.getState()
  if (help.overlay) {
    help.setOverlay(false)
    return
  }
  const cam = useCamStore.getState()
  if (isHelpModalId(cam.activeModal)) cam.closeModal()
}

/** The anchor of an error code's row in a topic's "what the errors mean"
 *  table: E_EXPR_UNBOUNDED -> error-e-expr-unbounded. */
export function errorCodeAnchor(code: string): string {
  return `error-${code.toLowerCase().replace(/_/g, '-')}`
}

/** True when the Help Center should be showing. */
export function isHelpOpen(activeModal: string | null, overlay: boolean): boolean {
  return overlay || isHelpModalId(activeModal)
}
