// WO-3305: the Sketches window. Lists every model sketch with its state; Use makes it operation
// geometry. A sketch whose plane cannot be cut shows the app's own reason under its name, and its
// Use is unavailable with that reason.
import { Button, Dialog, Pill, Tooltip } from '../../components/kit'
import { resolveMessage } from '../../notices'
import { closeSketchInput, useSketchInputOpen } from './state'
import { useSketchInputViewModel } from './useSketchInputViewModel'
import './sketchInput.css'

const t = (key: string) => resolveMessage(`ui2-sketch-input.wo3305:${key}`)

export function SketchInputDialog() {
  const open = useSketchInputOpen()
  const vm = useSketchInputViewModel(open)
  return (
    <Dialog
      open={open}
      title={t('title')}
      closeLabel={t('close')}
      onClose={closeSketchInput}
      testId="sketch-input-dialog"
    >
      <p className="ui2-sketch-input-intro">{t('intro')}</p>
      {vm.rows.length === 0
        ? <p className="ui2-sketch-input-intro" data-testid="sketch-input-empty">{t('empty')}</p>
        : (
          <ul className="ui2-sketch-input-list">
            {vm.rows.map((row) => (
              <li key={row.key} className="ui2-sketch-input-row" data-testid={`sketch-input-row-${row.key}`} data-status={row.status ?? 'none'}>
                <Tooltip text={row.name}>
                  <span className="ui2-sketch-input-name">{row.name}</span>
                </Tooltip>
                {row.pill && <Pill tone={row.pill.tone} label={row.pill.label} />}
                <Button
                  kind="momentary"
                  form="small"
                  label={t('use')}
                  availability={row.availability}
                  testId={`sketch-input-use-${row.key}`}
                  onPress={() => vm.use(row.key)}
                />
                {row.reason && <p className="ui2-sketch-input-reason">{row.reason}</p>}
              </li>
            ))}
          </ul>
        )}
    </Dialog>
  )
}
