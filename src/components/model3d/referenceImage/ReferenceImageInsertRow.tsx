import { useRef } from 'react'

export function ReferenceImageInsertRow({ onInsert, choiceLabel }: { onInsert(file: File): Promise<void>; choiceLabel?: string }) {
  const input = useRef<HTMLInputElement>(null)
  return <div className="sketch-snap-settings">
    {choiceLabel ? <button type="button" className="modal-btn modal-btn-ghost" data-testid="reference-image-insert" onClick={() => input.current?.click()}>{choiceLabel}</button> : <label className="sketch-snap-spacing" data-tooltip="Place a PNG or JPG on this sketch's plane as a see-through picture to trace over.">
      <span>Reference image</span>
      <button type="button" className="sketch-header-toggle" data-testid="reference-image-insert" onClick={() => input.current?.click()}>Insert...</button>
    </label>}
    <input ref={input} type="file" accept=".png,.jpg,.jpeg" data-testid="reference-image-input" style={{ display: 'none' }}
      onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void onInsert(file) }} />
  </div>
}
