import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
type RoughingScopeSelectorProps = {
  name: string
  useStockBoundary: boolean
  onChange: (useStockBoundary: boolean) => void
  testId: string
}

/**
 * The operator-facing two-mode control for Adaptive 3D roughing scope.
 * `useStockBoundary` remains the persisted compatibility field, but the UI
 * presents it as an explicit machining choice instead of an optional feature.
 */
export function RoughingScopeSelector({
  name,
  useStockBoundary,
  onChange,
  testId,
}: RoughingScopeSelectorProps) {
  useText('cam-operations-new-operation')
  return (
    <fieldset
      data-testid={testId}
      style={{
        border: 0,
        padding: 0,
        margin: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <legend style={{ padding: 0, marginBottom: 7, fontWeight: 600 }}>{tx('RoughingScopeSelector.Roughing_scope')}</legend>
      <label
        style={{ display: 'flex', alignItems: 'flex-start', gap: 7, cursor: 'pointer' }}
        data-tooltip={tx('RoughingScopeSelector.Everything_that_is_not_the_part')}
      >
        <input
          type="radio"
          name={name}
          value="clear-all-stock"
          checked={useStockBoundary}
          onChange={() => onChange(true)}
        />{tx('RoughingScopeSelector.Clear_all_stock_everything_that_is_not_the_part')}</label>
      <label
        style={{ display: 'flex', alignItems: 'flex-start', gap: 7, cursor: 'pointer' }}
        data-tooltip={tx('RoughingScopeSelector.Clear_every_accessible_side_without_clearing_the_whole_stock')}
      >
        <input
          type="radio"
          name={name}
          value="clear-around-part"
          checked={!useStockBoundary}
          onChange={() => onChange(false)}
        />{tx('RoughingScopeSelector.Clear_around_part')}</label>
    </fieldset>
  )
}
