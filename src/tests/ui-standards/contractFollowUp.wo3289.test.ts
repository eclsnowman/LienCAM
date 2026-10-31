// @vitest-environment jsdom
// WO-3289 (UI M2 Wave 0 follow-up): the one batch of contract changes the Wave 1 lanes asked for.
// Each case names the lane and PR that asked. Type-only changes (Card menuLabel and the required
// closeLabel, OpSchemaRendererProps context and renderSlot) are checked by tsc -b through the
// typed fixtures at the end of this file.
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ICON_CLASS, ICON_ID_ATTRIBUTE } from '../../components/kit'
import type { CardProps } from '../../components/kit'
import { MESSAGE_KEY_PATTERN } from '../../notices/types'
import { SLOT_PARAM_TYPES } from '../../lib/opschema/types'
import type { OpSchemaRendererProps, ParamDecl } from '../../lib/opschema/types'
import { createUnitsService, DEFAULT_UNIT_PREFS } from '../../lib/units'
import { tokenCss, WIDGET } from '../../theme/tokens'
import { typedMock } from '../support/typedMock'

const connect = vi.hoisted(() => vi.fn())
vi.mock('../../lib/units/format/appPrefs', () => typedMock<typeof import('../../lib/units/format/appPrefs')>({ connectAppUnitPrefs: connect }))
const { Ui2Root } = await import('../../ui2/Ui2Root')

afterEach(cleanup)

describe('WO-3289 contract follow-up', () => {
  it('names the icon hook a button icon renders, for the icon set (W1-C, PR 124)', () => {
    expect(ICON_CLASS).toBe('kit-icon')
    expect(ICON_ID_ATTRIBUTE).toBe('data-icon')
  })

  it('names the control widths the actions lane found missing, and emits them as tokens (W1-C, PR 124)', () => {
    expect(WIDGET).toEqual({ anchoredField: 72, menu: 160, tooltip: 260, showCard: 168, viewCube: 56 })
    const css = tokenCss()
    for (const decl of ['--w-anchored:72px', '--w-menu:160px', '--w-tooltip:260px', '--w-showcard:168px', '--w-cube:56px']) {
      expect(css).toContain(decl)
    }
  })

  it('pins feeds at one decimal, as the screens show them today (W1-D, PR 130)', () => {
    const units = createUnitsService()
    expect(units.formatFeed(1600)).toBe('1600.0 mm/min')
    expect(units.formatFeed(254, { prefs: { ...DEFAULT_UNIT_PREFS, length: 'inch' } })).toBe('10.0 in/min')
  })

  it('accepts area names with digits and dots in a reason key (W1-D, PR 130)', () => {
    expect('ui2-notices.wo3281:wrongUnit').toMatch(MESSAGE_KEY_PATTERN)
    expect('sketch-and-model-workbench:SolidsWorkbenchPage.enterANumber').toMatch(MESSAGE_KEY_PATTERN)
    expect('tab-removal.wo3221:reason').toMatch(MESSAGE_KEY_PATTERN)
    expect('no area here').not.toMatch(MESSAGE_KEY_PATTERN)
    expect(':missingArea').not.toMatch(MESSAGE_KEY_PATTERN)
  })

  it('leaves room for the tool and geometry pickers in the opschema card (W1-F, PR 123)', () => {
    expect([...SLOT_PARAM_TYPES]).toEqual(['tool', 'geometry'])
  })

  it('connects the units service to the operator preferences once, when the New UI mounts (W1-D, PR 130)', () => {
    connect.mockClear()
    const { rerender } = render(createElement(Ui2Root))
    rerender(createElement(Ui2Root, { theme: 'light' }))
    expect(connect).toHaveBeenCalledTimes(1)
  })
})

// Typed fixtures: tsc -b fails when the contract lacks these fields.
const card: CardProps = { title: 'Pocket', menu: null, menuLabel: 'More', onClose() {}, closeLabel: 'Close' }
// @ts-expect-error a Card with a close handler must name the close button
const unnamed: CardProps = { title: 'Pocket', onClose() {} }
const renderer: OpSchemaRendererProps = {
  schema: { opType: 'pocket', params: [] },
  values: {},
  onChange() {},
  context: { toolDiameter: 6 },
  renderSlot: (decl: ParamDecl) => (decl.type === 'tool' ? null : undefined),
}
void [card, unnamed, renderer]
