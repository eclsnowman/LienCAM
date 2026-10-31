// WO-3278: the live demo components behind gallery.tsx. Each keeps its own state; the labels are
// sample words for the gallery only.
import { useEffect, useRef, useState } from 'react'
import type { Availability } from '../../../commands/types'
import type { Quantity } from '../../../lib/units/types'
import { NumberField, Segmented, Select, Slider, TextField, Toggle } from '.'

const MODES = [{ value: 'climb', label: 'Climb' }, { value: 'conventional', label: 'Conventional' }] as const
const KINDS = [{ value: 'a', label: 'Flat' }, { value: 'b', label: 'Ball' }, { value: 'c', label: 'Bull' }, { value: 'd', label: 'V-bit' }, { value: 'e', label: 'Drill' }] as const

export function NumberDemo({ quantity, start, availability, optional, label = 'Value' }: { quantity: Quantity; start: number | null; availability?: Availability; optional?: boolean; label?: string }) {
  const [v, setV] = useState<number | null>(start)
  return <NumberField ariaLabel={label} value={v} quantity={quantity} onChange={setV} availability={availability} optional={optional} min={0} max={100000} />
}

/** Types an unreadable entry the way an operator would, so the invalid look can be shown. */
export function InvalidNumberDemo() {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const input = root.current?.querySelector('input')
    if (!input) return
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    set?.call(input, 'abc')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    // the entry is committed after React has taken the typed text
    const timer = setTimeout(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 0)
    return () => clearTimeout(timer)
  }, [])
  return <div ref={root} className="kit-example-pad"><NumberDemo quantity="length" start={12.5} /></div>
}

export function TextDemo({ availability, mono, label = 'Name', start = 'Pocket 1' }: { availability?: Availability; mono?: boolean; label?: string; start?: string }) {
  const [v, setV] = useState(start)
  return <TextField ariaLabel={label} value={v} onChange={setV} availability={availability} mono={mono} placeholder={label} />
}

export function PickDemo({ availability, label = 'Tool kind' }: { availability?: Availability; label?: string }) {
  const [v, setV] = useState<string>('a')
  return <Select ariaLabel={label} value={v} options={KINDS} onChange={setV} availability={availability} />
}

export function SegDemo({ availability, label = 'Cut direction', options = MODES, start = 'climb' }: { availability?: Availability; label?: string; options?: readonly { value: string; label: string }[]; start?: string }) {
  const [v, setV] = useState<string>(start)
  return <Segmented ariaLabel={label} value={v} options={options} onChange={setV} availability={availability} />
}

export function TogDemo({ start, availability, label = 'Holding tabs' }: { start: boolean; availability?: Availability; label?: string }) {
  const [on, setOn] = useState(start)
  return <Toggle ariaLabel={label} label={label} on={on} onChange={setOn} availability={availability} />
}

export function SliDemo({ availability, label = 'Angle', quantity = 'angle' }: { availability?: Availability; label?: string; quantity?: Quantity }) {
  const [v, setV] = useState(60)
  return <Slider ariaLabel={label} value={v} min={0} max={90} step={1} quantity={quantity} onChange={setV} availability={availability} />
}

