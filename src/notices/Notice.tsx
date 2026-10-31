// WO-3281 (UI M2 W1-D): the notice part. The text always comes from the catalogue key, with the
// level word beside it; looks live in catalogue/notice.css on theme roles only.
import { LEVEL_LABEL } from './catalogue'
import './catalogue/notice.css'
import { resolveMessage } from '.'
import type { NoticeProps } from '../components/kit/types'

export function Notice(p: NoticeProps) {
  const { notice } = p
  return (
    <div className="kit-notice" role={notice.level === 'info' ? 'status' : 'alert'} data-kit="Notice" data-level={notice.level} data-testid={p.testId}>
      <span className="kit-notice-level">{resolveMessage(LEVEL_LABEL[notice.level])}</span>
      <span className="kit-notice-text">{resolveMessage(notice.key, notice.params)}</span>
      {p.onDismiss && <button type="button" className="kit-notice-dismiss" aria-label={p.closeLabel} onClick={() => p.onDismiss?.(notice.id)} />}
    </div>
  )
}
