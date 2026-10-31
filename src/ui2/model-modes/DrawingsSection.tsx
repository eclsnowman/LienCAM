// WO-3301 (UI M2 W2-8): the Drawings section of the Model Browser: the item's drawings, Create drawing from the
// selected body, open, delete with its undo. The list, the create action and the delete are the Drawings section
// of today's Model panel (components/model3d/drawing/DrawingEntry), read through its port.
import { BrowserRow, Button } from '../../components/kit'
import { useText } from '../../i18n'
import { useModePortSession } from '../../components/model3d/form/modePort'
import { drawingsModelPort } from '../../components/model3d/drawing/drawingModePort'

export function DrawingsSection() {
  const t = useText('technical-drawings')
  const model = useModePortSession(drawingsModelPort)
  if (model === null) return null
  const createTip = model.canCreate ? t('entry.createTip') : model.bodyCount > 1 ? t('entry.createPickOne', { count: model.bodyCount }) : t('entry.createNeedsBody')
  return (
    <div className="ui2-drawings" data-testid="ui2-drawings">
      <Button
        kind="momentary"
        form="text"
        testId="ui2-drawing-create"
        label={model.creating ? t('entry.creating') : t('entry.create')}
        availability={model.canCreate ? { ready: true } : { ready: false, reason: model.bodyCount > 1 ? 'technical-drawings:entry.createPickOne' : 'technical-drawings:entry.createNeedsBody', params: { count: model.bodyCount } }}
        onPress={model.create}
      />
      {model.canCreate && <span className="ui2-drawings-tip">{createTip}</span>}
      {model.notice !== null && <div role="status" data-testid="ui2-drawing-notice">{model.notice}</div>}
      {model.removedName !== null && (
        <div role="status" data-testid="ui2-drawing-removed">
          {t('entry.removed', { name: model.removedName })}{' '}
          <Button kind="momentary" form="text" testId="ui2-drawing-undo-remove" label={t('entry.undoRemove')} onPress={model.undoRemove} />
        </div>
      )}
      {model.drawings.length === 0 && <div className="ui2-drawings-empty">{t('entry.empty')}</div>}
      {model.drawings.map(d => (
        <BrowserRow
          key={d.id}
          depth={0}
          name={d.name}
          icon="drawing"
          meta={d.sourceGone ? t('entry.sourceGone') : undefined}
          status={d.sourceGone ? 'warn' : undefined}
          selected={model.openId === d.id}
          testId={`ui2-drawing-row-${d.id}`}
          onSelect={() => model.open(d.id)}
          actions={
            <Button
              kind="momentary"
              form="icon"
              icon="delete"
              testId={`ui2-drawing-remove-${d.id}`}
              label={t('entry.removeTip', { name: d.name })}
              onPress={() => model.remove(d.id)}
            />
          }
        />
      ))}
    </div>
  )
}
