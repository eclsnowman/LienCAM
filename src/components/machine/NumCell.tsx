import { useSelectAllOnClick } from '../ui/selectAllOnClick'

interface NumCellProps {
  shown: string
  onCommit: (text: string) => boolean | void
  className?: string
  editable?: boolean
  max?: number
  min?: number
  tooltip?: string
  ariaLabel?: string
  placeholder?: string
  step?: number
  testId?: string
}

/**
 * Shared machine-panel numeric edit contract. The field stays uncontrolled so
 * Escape can restore the last committed display value without changing the
 * owning store, while a changed external value still wins through the key.
 */
export function NumCell({
  shown,
  onCommit,
  className = 'control-offset-input',
  editable = true,
  max,
  min,
  tooltip,
  ariaLabel,
  placeholder,
  step,
  testId,
}: NumCellProps) {
  const selectAll = useSelectAllOnClick()

  return (
    <input
      key={shown}
      className={className}
      type="text"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      defaultValue={shown}
      data-tooltip={tooltip}
      aria-label={ariaLabel}
      placeholder={placeholder}
      disabled={!editable}
      data-testid={testId}
      onFocus={selectAll.onFocus}
      onMouseUp={selectAll.onMouseUp}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          event.currentTarget.value = shown
          event.currentTarget.blur()
        }
      }}
      onBlur={(event) => {
        if (event.currentTarget.value === shown) return
        if (onCommit(event.currentTarget.value) === false) {
          event.currentTarget.value = shown
        }
      }}
    />
  )
}
