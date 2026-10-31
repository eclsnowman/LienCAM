// WO-3308: the Layout menu of the machine bar: the layout in use, picking another, and the
// button that enters Arrange. Arrange is never refused: it works while the machine moves.
import { Button, Select } from '../../components/kit'
import { useText } from '../../i18n'
import { DEFAULT_LAYOUT_ID } from './layout'
import { useControlLayouts } from '../../store/slices/controlLayouts'
import type { ControlLayoutApi } from './useControlLayout'

export function LayoutMenu({ api, machine }: { api: ControlLayoutApi; machine: string }) {
  const t = useText('ui2-control-arrange.wo3308')
  const pick = useControlLayouts(s => s.pick)
  const options = [{ value: DEFAULT_LAYOUT_ID, label: t('defaultName') }, ...api.record.saved.map(s => ({ value: s.id, label: s.name }))]
  return (
    <div className="arrange-menu" data-testid="layout-menu">
      <Select ariaLabel={t('layoutMenu')} testId="layout-menu-pick" value={api.record.activeId} options={options}
        onChange={id => pick(machine, id)} />
      <Button kind="latched" form="text" label={t('arrange')} testId="layout-menu-arrange" on={api.arranging}
        onToggle={on => (on ? api.enter() : api.leave())} />
    </div>
  )
}
