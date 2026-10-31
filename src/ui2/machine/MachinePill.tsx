// WO-3303: the machine pill of the app bar. It names the machine and its state (offline, not homed,
// ready, running, held) from the same derivation as today's status chip, and opens the Machine
// window. A project that opens without a known machine asks through a card dropped from the pill.
import { useState } from 'react'
import { useText } from '../../i18n'
import { Button, Card, Pill, type Tone } from '../../components/kit'
import { useCamStore } from '../../store'
import { choosableMachines } from '../../lib/machine/machineChoice'
import { useMachineChipView } from '../../components/toolbar/MachineStatusChip'
import { openMachineWindow } from './windowState'
import './machine.css'

const TONE: Record<string, Tone> = {
  offline: 'neutral', 'not-homed': 'warn', ready: 'ok', running: 'accent', held: 'warn', alarm: 'err', stopped: 'err',
}

export function MachinePill() {
  const t = useText('ui2-machine.wo3303')
  const name = useCamStore(s => s.project.machine.name)
  const { chip, label } = useMachineChipView()
  return (
    <span className="ui2-machine-pill" data-testid="machine-pill" data-state={chip.state}>
      <Button kind="momentary" emphasis="ghost" testId="machine-pill-open" label={name} onPress={openMachineWindow} />
      <span role="status" aria-live="polite" aria-label={t('pillState', { name, state: label })} data-testid="machine-pill-state-wrap">
        <Pill testId="machine-pill-state" tone={TONE[chip.state] ?? 'neutral'} label={label} />
      </span>
      <MachineChoiceCard />
    </span>
  )
}

/** The forced choice of a machine for the project (today's Machine choice prompt), as a card dropped
 *  from the pill. It closes only by choosing, as the prompt does. */
export function MachineChoiceCard() {
  const t = useText('ui2-machine.wo3303')
  const required = useCamStore(s => s.machineChoiceRequired)
  const setRequired = useCamStore(s => s.setMachineChoiceRequired)
  const library = useCamStore(s => s.machineLibrary)
  const defaultId = useCamStore(s => s.appSettings.defaultMachineId)
  const setProjectMachine = useCamStore(s => s.setProjectMachine)
  const [picked, setPicked] = useState<string | null>(null)
  const choices = choosableMachines(library).sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId))
  // the operator's default leads and is chosen until they pick another
  if (!required) return null
  const chosen = choices.find(m => m.id === picked) ?? choices.find(m => m.id === defaultId) ?? choices[0] ?? null
  return (
    <div className="ui2-machine-choice" data-testid="machine-choice-card">
      <Card
        title={t('choiceTitle')}
        footer={{
          ghost: { label: t('choiceOpenLibrary'), onPress: openMachineWindow },
          primary: { label: t('choiceUse'), onPress: () => { if (chosen) { setProjectMachine({ ...chosen }); setRequired(false) } } },
        }}
      >
        <p className="ui2-machine-note">{t('choiceNote')}</p>
        {choices.length === 0 && <p className="ui2-machine-note" data-testid="machine-choice-empty">{t('choiceEmpty')}</p>}
        <div className="ui2-machine-choices" role="group" aria-label={t('choiceTitle')}>
          {choices.map(m => (
            <Button
              key={m.id}
              kind="choice"
              testId={`machine-choice-${m.id}`}
              label={m.id === defaultId ? t('choiceDefault', { name: m.name }) : m.name}
              selected={m.id === chosen?.id}
              onSelect={() => setPicked(m.id)}
            />
          ))}
        </div>
      </Card>
    </div>
  )
}
