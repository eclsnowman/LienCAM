import { textFor, useText } from '../../../i18n'
const text = textFor('sketch-and-model-workbench')

export function parseHoleMove(draft: string): { ok: true; translation: [number,number,number] } | { ok: false; reason: string } {
  const parts = draft.split(',')
  const values = parts.map(Number)
  if (parts.length !== 3 || parts.some(v => v.trim() === '') || values.some(v => !Number.isFinite(v))) {
    return { ok: false, reason: text('MoveHoleEntry.finite') }
  }
  if (Math.hypot(...values) < 1e-9) return { ok: false, reason: text('MoveHoleEntry.nonzero') }
  return { ok: true, translation: values as [number,number,number] }
}

export function MoveHoleEntry({draft,onChange,status,message,onApply,onCancel}: {
  draft: string; onChange(value:string):void; status:string; message:string;
  onApply():void; onCancel():void;
}) {
  const t = useText('sketch-and-model-workbench')
  const values = draft.split(',')
  return <div data-testid="move-hole-entry" role="dialog" aria-label={t('MoveHoleEntry.title')} className="wb-dialog"
    onKeyDown={e => { if(e.key==='Escape' && status!=='applying') {e.stopPropagation();onCancel()} else if(e.key==='Enter' && (status==='ready'||status==='pending')) {e.preventDefault();onApply()} }} style={{position:'absolute',right:24,top:100,padding:16,width:300,background:'var(--surface-2)',border:'1px solid var(--border-subtle)',borderRadius:8,zIndex:30}}>
    <strong>{t('MoveHoleEntry.title')}</strong>
    <p>{t('MoveHoleEntry.hint')}</p>
    {['X','Y','Z'].map((axis,i) => <label key={axis} style={{display:'flex',gap:12,alignItems:'center',marginBottom:8}}>
      {axis} (mm)
      <input type="number" step="any" aria-label={`Delta ${axis}`} data-testid={`move-hole-${axis.toLowerCase()}`}
        value={values[i] ?? '0'} disabled={status==='applying'} style={{width:160}}
        onChange={e => { const next=[...values];next[i]=e.target.value;onChange(next.join(',')) }} />
    </label>)}
    <p data-testid="move-hole-status" data-status={status} role="status">{message}</p>
    <button type="button" className="modal-btn modal-btn-primary" data-testid="move-hole-apply" disabled={status!=='ready' && status!=='pending'} onClick={onApply}>{t('MoveHoleEntry.apply')}</button>{' '}
    <button type="button" className="modal-btn modal-btn-ghost" data-testid="move-hole-cancel" disabled={status==='applying'} onClick={onCancel}>{t('MoveHoleEntry.cancel')}</button>
  </div>
}
