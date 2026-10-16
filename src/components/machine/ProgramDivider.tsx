import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { PROGRAM_PREVIEW_DEFAULT_PERCENT, useUiPrefs } from '../../store/uiPrefs'

export { PROGRAM_PREVIEW_DEFAULT_PERCENT }
export const PROGRAM_PREVIEW_MIN_PX = 120
export const PROGRAM_LIST_MIN_PX = 160
export const PROGRAM_DIVIDER_PX = 8

const KEYBOARD_STEP_PERCENT = 2
const KEYBOARD_FAST_STEP_PERCENT = 10

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10
}

export function normalizedProgramPreviewPercent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, roundPercent(value)))
    : PROGRAM_PREVIEW_DEFAULT_PERCENT
}

export function programPreviewPercentForWidth(value: number, containerWidth: number): number {
  const available = Math.max(1, containerWidth - PROGRAM_DIVIDER_PX)
  const minimum = (PROGRAM_PREVIEW_MIN_PX / available) * 100
  const maximum = 100 - (PROGRAM_LIST_MIN_PX / available) * 100

  // Below the combined minimum there is no split that can satisfy both panes.
  // Keep their minimum-width ratio stable; CSS then lets the center stage clip
  // rather than silently taking either pane all the way to zero.
  if (minimum > maximum) {
    return roundPercent(
      (PROGRAM_PREVIEW_MIN_PX / (PROGRAM_PREVIEW_MIN_PX + PROGRAM_LIST_MIN_PX)) * 100,
    )
  }
  return roundPercent(Math.min(maximum, Math.max(minimum, value)))
}

export function setProgramPreviewPercent(value: number): void {
  const normalized = normalizedProgramPreviewPercent(value)
  useUiPrefs.setState({ machineProgramPreviewPercent: normalized })
}

export function useProgramPreviewPercent(): number {
  return useUiPrefs((state) =>
    normalizedProgramPreviewPercent(state.machineProgramPreviewPercent),
  )
}

export function programSplitGridStyle(previewPercent: number): CSSProperties {
  const normalized = normalizedProgramPreviewPercent(previewPercent)
  return {
    '--control-program-preview-fr': `${normalized}fr`,
    '--control-program-list-fr': `${roundPercent(100 - normalized)}fr`,
  } as CSSProperties
}

export function ProgramDivider({ previewPercent }: { previewPercent: number }) {
  useText('control-screens-not-probing')
  const removeDragListeners = useRef<(() => void) | null>(null)

  useEffect(() => () => removeDragListeners.current?.(), [])

  const adjustByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const measuredWidth = event.currentTarget.closest<HTMLElement>('.control-col-main')
      ?.getBoundingClientRect().width
    const width = measuredWidth && measuredWidth > PROGRAM_DIVIDER_PX
      ? measuredWidth
      : Number.POSITIVE_INFINITY
    const step = event.shiftKey ? KEYBOARD_FAST_STEP_PERCENT : KEYBOARD_STEP_PERCENT
    const direction = event.key === 'ArrowRight' ? 1 : -1
    setProgramPreviewPercent(
      programPreviewPercentForWidth(previewPercent + direction * step, width),
    )
  }

  return (
    <div
      className="control-program-divider"
      data-testid="control-program-divider"
      role="separator"
      aria-label={controlText('ProgramDivider.text001')}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={previewPercent}
      aria-valuetext={`${previewPercent}% preview, ${100 - previewPercent}% G-code list`}
      tabIndex={0}
      onKeyDown={adjustByKeyboard}
      onDoubleClick={() => setProgramPreviewPercent(PROGRAM_PREVIEW_DEFAULT_PERCENT)}
      onPointerDown={(event) => {
        event.preventDefault()
        removeDragListeners.current?.()
        const columns = event.currentTarget.closest<HTMLElement>('.control-col-main')
        if (!columns) return
        const startX = event.clientX
        const startPercent = previewPercent
        const width = columns.getBoundingClientRect().width
        const available = Math.max(1, width - PROGRAM_DIVIDER_PX)

        const onMove = (moveEvent: PointerEvent) => {
          const next = startPercent + ((moveEvent.clientX - startX) / available) * 100
          setProgramPreviewPercent(programPreviewPercentForWidth(next, width))
        }
        const remove = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', remove)
          window.removeEventListener('pointercancel', remove)
          removeDragListeners.current = null
        }
        removeDragListeners.current = remove
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', remove)
        window.addEventListener('pointercancel', remove)
      }}
    />
  )
}
