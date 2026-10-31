// WO-3303: the Library page: every machine profile, which one this project uses, the default, and
// the actions on the selected one. Editing the CAM half of a profile (travel envelope, tool changer)
// and profile import stay in today's editor, opened from here, until a follow-up moves them.
import { useState } from 'react'
import { useText } from '../../i18n'
import { Button, BrowserRow, Card, Confirm, PropRow } from '../../components/kit'
import { useCamStore } from '../../store'
import { openMachineDefinition, setMachineWindowMachine } from './windowState'

export function LibraryPage({ selectedId }: { selectedId: string }) {
  const t = useText('ui2-machine.wo3303')
  const library = useCamStore(s => s.machineLibrary)
  const projectMachine = useCamStore(s => s.project.machine)
  const defaultId = useCamStore(s => s.appSettings.defaultMachineId)
  const setProjectMachine = useCamStore(s => s.setProjectMachine)
  const setDefaultMachineId = useCamStore(s => s.setDefaultMachineId)
  const remove = useCamStore(s => s.removeMachineFromLibrary)
  const openModal = useCamStore(s => s.openModal)
  const [confirming, setConfirming] = useState(false)
  const selected = library.find(m => m.id === selectedId)
  return (
    <div className="ui2-machine-library" data-testid="machine-library">
      <p className="ui2-machine-note">{t('libraryHelp')}</p>
      <div className="ui2-machine-library-split">
        <div className="ui2-machine-list" role="list" aria-label={t('navLibrary')}>
          {library.map(m => (
            <BrowserRow
              key={m.id}
              testId={`machine-library-row-${m.id}`}
              depth={0}
              name={m.name}
              meta={m.id === projectMachine.id ? t('inProject') : m.id === defaultId ? t('defaultTag') : m.controller.toUpperCase()}
              selected={m.id === selectedId}
              onSelect={() => setMachineWindowMachine(m.id)}
            />
          ))}
          {library.length === 0 && <p className="ui2-machine-note" data-testid="machine-library-empty">{t('libraryEmpty')}</p>}
        </div>
        {selected && (
          <Card testId="machine-library-detail" title={selected.name}>
            <PropRow label={t('controllerLabel')}>{selected.controller.toUpperCase()}</PropRow>
            <PropRow label={t('travel')}>{t('travelValue', { x: selected.travel.x, y: selected.travel.y, z: selected.travel.z })}</PropRow>
            <div className="ui2-machine-actions">
              <Button kind="momentary" testId="machine-library-use" emphasis="primary" label={t('useForProject')} onPress={() => setProjectMachine({ ...selected })} />
              <Button kind="momentary" testId="machine-library-default" label={t('makeDefault')} onPress={() => setDefaultMachineId(selected.id)} />
              <Button kind="momentary" testId="machine-library-definition" label={t('openDefinition')} onPress={() => openMachineDefinition('overview', selected.id)} />
              <Button kind="momentary" testId="machine-library-editor" label={t('openEditor')} onPress={() => openModal('machine-config')} />
              <Button kind="momentary" testId="machine-library-remove" emphasis="danger" label={t('remove')} onPress={() => setConfirming(true)} />
            </div>
          </Card>
        )}
      </div>
      <Confirm
        testId="machine-library-confirm"
        open={confirming && selected !== undefined}
        title={t('removeTitle')}
        sentence={t('removeSentence', { name: selected?.name ?? '' })}
        actionLabel={t('removeAction', { name: selected?.name ?? '' })}
        cancelLabel={t('cancel')}
        danger
        onConfirm={() => { if (selected) { remove(selected.id); setMachineWindowMachine(null) } setConfirming(false) }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}
