// WO-3308: the Arrange window. Every module with its column, a show switch and move keys; locked
// parts are listed with a lock and cannot be touched. Saved layouts: save the screen under a name,
// pick, rename, delete, and return to the Run layout. Moving a module never changes what it does.
import { useState } from 'react'
import { Button, Card, Segmented, Select, TextField, Toggle } from '../../components/kit'
import { useText } from '../../i18n'
import { resolveMessage } from '../../notices'
import { DEFAULT_LAYOUT_ID, CONTROL_MODULE_IDS, CONTROL_COLUMNS, LOCKED_PARTS, isLocked, placementOf } from './layout'
import { COLUMN_LABEL_KEY, LOCKED_LABEL_KEY, MODULE_LABEL_KEY } from './modules'
import { useControlLayouts } from '../../store/slices/controlLayouts'
import type { ControlLayoutApi } from './useControlLayout'
import './arrange.css'

export function ArrangeWindow({ api, machine }: { api: ControlLayoutApi; machine: string }) {
  const t = useText('ui2-control-arrange.wo3308')
  const store = useControlLayouts()
  const [name, setName] = useState('')
  const { layout, record } = api
  const activeSaved = record.saved.find(s => s.id === record.activeId)
  const layoutOptions = [
    { value: DEFAULT_LAYOUT_ID, label: t('defaultName') },
    ...record.saved.map(s => ({ value: s.id, label: s.name })),
  ]
  const order = layout.placements.map(p => p.id).filter(id => CONTROL_MODULE_IDS.includes(id))
  return (
    <Card title={t('windowTitle')} testId="arrange-window" onClose={api.leave} closeLabel={t('done')}
      footer={{ primary: { label: t('done'), onPress: api.leave } }}>
      <div className="arrange-win" data-lc="arrange-window">
        <div className="arrange-row">
          <Select ariaLabel={t('pick')} testId="arrange-pick" value={record.activeId} options={layoutOptions}
            onChange={id => store.pick(machine, id)} />
          {api.changed && <span className="arrange-changed" data-testid="arrange-changed">{t('changed')}</span>}
        </div>
        <ul className="arrange-list" aria-label={t('windowTitle')}>
          {order.map(id => {
            const p = placementOf(layout, id)
            const label = t(MODULE_LABEL_KEY[id])
            const locked = isLocked(id)
            if (locked) {
              return (
                <li key={id} className="arrange-item" data-testid={`arrange-row-${id}`} data-locked>
                  <span className="arrange-name">{label}<span className="arrange-lock" aria-label={t('locked')}>{' \u{1F512}'}</span></span>
                </li>
              )
            }
            return (
              <li key={id} className="arrange-item" data-testid={`arrange-row-${id}`}>
                <span className="arrange-name">{label}</span>
                <Segmented ariaLabel={`${label}: ${t('column')}`} testId={`arrange-col-${id}`} value={p.column}
                  options={CONTROL_COLUMNS.map(c => ({ value: c, label: t(COLUMN_LABEL_KEY[c]) }))}
                  onChange={c => api.move(id, c, Number.MAX_SAFE_INTEGER)} />
                <Button kind="momentary" form="icon" icon="move-up" label={t('moveUp')} testId={`arrange-up-${id}`} onPress={() => api.nudge(id, -1)} />
                <Button kind="momentary" form="icon" icon="move-down" label={t('moveDown')} testId={`arrange-down-${id}`} onPress={() => api.nudge(id, 1)} />
                <Toggle ariaLabel={`${label}: ${t('show')}`} label={t('show')} testId={`arrange-show-${id}`} on={p.shown}
                  onChange={on => api.show(id, on)} />
              </li>
            )
          })}
          {LOCKED_PARTS.map(part => (
            <li key={part} className="arrange-item" data-testid={`arrange-locked-${part}`} data-locked>
              <span className="arrange-name">{t(LOCKED_LABEL_KEY[part])}<span className="arrange-lock" aria-label={t('locked')}>{' \u{1F512}'}</span></span>
            </li>
          ))}
        </ul>
        <p className="arrange-note">{resolveMessage('ui2-control-arrange.wo3308:lockedNote')}</p>
        <div className="arrange-row">
          <TextField ariaLabel={t('layoutName')} testId="arrange-name" value={name} onChange={setName} placeholder={t('layoutName')} />
          <Button kind="momentary" form="text" label={t('saveAs')} testId="arrange-save-as"
            onPress={() => { store.saveAs(machine, name || t('layout')); setName('') }} />
          {activeSaved && <Button kind="momentary" form="text" label={t('save')} testId="arrange-save" onPress={() => store.saveActive(machine)} />}
          {activeSaved && <Button kind="momentary" form="text" label={t('rename')} testId="arrange-rename"
            onPress={() => { if (name.trim()) { store.rename(machine, activeSaved.id, name); setName('') } }} />}
          {activeSaved && <Button kind="momentary" form="text" emphasis="danger" label={t('delete')} testId="arrange-delete"
            onPress={() => store.remove(machine, activeSaved.id)} />}
          <Button kind="momentary" form="text" label={t('resetDefault')} testId="arrange-reset" onPress={() => store.resetToDefault(machine)} />
        </div>
      </div>
    </Card>
  )
}
