// HELP-1 S2: context derivation + ranking, pure-function tests.

import { describe, it, expect } from 'vitest'
import { deriveHelpContext, rankTopics, type HelpContextSource } from '../../help/helpContext'
import { useHelpContext } from '../../help/helpContextStore'
import type { HelpIndexEntry } from '../../help/types'

function baseState(over: Partial<HelpContextSource> = {}): HelpContextSource {
  return {
    workspace: 'cam',
    activeModal: null,
    viewer: { mode: 'setup', selectedGeometryId: null },
    project: { activeOperationId: null, setups: [] },
    consoleEvents: [],
    consoleReadThroughId: 0,
    ...over,
  }
}

function entry(id: string, contextKeys: string[]): HelpIndexEntry {
  return { id, title: id, category: 'getting-started', summary: '', keywords: '', contextKeys }
}

describe('deriveHelpContext', () => {
  it('always carries mode and workspace; help modal itself never counts', () => {
    expect(deriveHelpContext(baseState({ activeModal: 'help' }))).toEqual([
      'mode:setup',
      'workspace:cam',
    ])
  })

  it('an open modal is the most specific signal', () => {
    const keys = deriveHelpContext(baseState({ activeModal: 'new-setup' }))
    expect(keys).toContain('modal:new-setup')
  })

  it('a selected operation yields its type and the properties-panel key', () => {
    const keys = deriveHelpContext(
      baseState({
        project: {
          activeOperationId: 'op1',
          setups: [{ operations: [{ id: 'op1', type: 'adaptive_2d' }] }],
        },
      }),
    )
    expect(keys).toContain('selection:operation:adaptive_2d')
    expect(keys).toContain('panel:properties:operation')
  })

  it('unread console errors raise error:recent; read-through clears it', () => {
    const events = [{ id: 3, severity: 'error' }]
    expect(
      deriveHelpContext(baseState({ consoleEvents: events, consoleReadThroughId: 0 })),
    ).toContain('error:recent')
    expect(
      deriveHelpContext(baseState({ consoleEvents: events, consoleReadThroughId: 3 })),
    ).not.toContain('error:recent')
  })
})

describe('rankTopics', () => {
  const topics = [
    entry('a-workspace', ['workspace:cam']),
    entry('b-mode', ['mode:sketch']),
    entry('c-modal', ['modal:new-operation']),
    entry('d-none', ['workspace:part']),
  ]

  it('modal beats mode beats workspace; non-matches keep index order', () => {
    const out = rankTopics(topics, ['modal:new-operation', 'mode:sketch', 'workspace:cam'])
    expect(out.suggested.map((t) => t.id)).toEqual(['c-modal', 'b-mode', 'a-workspace'])
    expect(out.rest.map((t) => t.id)).toEqual(['d-none'])
  })

  it('no active keys means no suggested group', () => {
    const out = rankTopics(topics, [])
    expect(out.suggested).toEqual([])
    expect(out.rest).toHaveLength(4)
  })
})

describe('pushed context keys (useHelpContext store)', () => {
  it('push/pop keeps nested duplicates balanced', () => {
    const s = () => useHelpContext.getState()
    s().push('modal:extrude-dialog')
    s().push('modal:extrude-dialog')
    expect(s().pushed).toEqual(['modal:extrude-dialog', 'modal:extrude-dialog'])
    s().pop('modal:extrude-dialog')
    expect(s().pushed).toEqual(['modal:extrude-dialog'])
    s().pop('modal:extrude-dialog')
    expect(s().pushed).toEqual([])
    s().pop('modal:extrude-dialog') // popping empty is harmless
    expect(s().pushed).toEqual([])
  })
})
