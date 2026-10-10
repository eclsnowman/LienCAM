import { useEffect, type RefObject } from 'react'
import { isTypingTarget } from '../../lib/sketch/tools/shortcuts'

export interface TypeToSetOptions {
  enabled: boolean
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter !== undefined) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * While a numeric palette is armed, seed its primary input from a direct
 * numeric keystroke. Capture phase plus stopImmediatePropagation gives the
 * palette first claim on sketch digits 1/2 before tool-shortcut listeners.
 */
export function useTypeToSet(
  inputRef: RefObject<HTMLInputElement | null>,
  { enabled }: TypeToSetOptions,
): void {
  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (!/^[0-9.-]$/.test(event.key)) return
      if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return

      const input = inputRef.current
      if (input === null) return

      event.preventDefault()
      event.stopImmediatePropagation()
      setNativeInputValue(input, event.key)
      input.focus({ preventScroll: true })
      queueMicrotask(() => {
        const caret = input.value.length
        input.setSelectionRange(caret, caret)
      })
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [enabled, inputRef])
}
