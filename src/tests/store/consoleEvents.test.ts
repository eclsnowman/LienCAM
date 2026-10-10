// WO UI-11A: typed session event-log store slice (BottomConsole's data
// source). Pure store tests (no React render) — exercise the actions
// directly via getState(), mirroring selectedNest.test.ts's approach.
//
// Coverage (acceptance criterion 1):
//  (a) addEvent appends with monotonic ids;
//  (b) the ring cap (CONSOLE_EVENT_CAP) evicts the oldest entries;
//  (c) clearEvents empties the log (and resets the read marker);
//  (d) the unread-error selector counts errors since the last markConsoleRead
//      ("since last expand").

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore, CONSOLE_EVENT_CAP, selectUnreadConsoleErrorCount } from '../../store'

beforeEach(() => {
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
})

describe('addConsoleEvent', () => {
  it('(a) appends events with monotonic ids', () => {
    useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message: 'one' })
    useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message: 'two' })
    useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message: 'three' })

    const events = useCamStore.getState().consoleEvents
    expect(events.map(e => e.message)).toEqual(['one', 'two', 'three'])
    expect(events[0].id).toBeLessThan(events[1].id)
    expect(events[1].id).toBeLessThan(events[2].id)
  })

  it('stamps each event with an epoch-ms `at` and the given severity/source/message', () => {
    const before = Date.now()
    useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'batch', message: 'boom' })
    const after = Date.now()

    const e = useCamStore.getState().consoleEvents[0]
    expect(e.severity).toBe('error')
    expect(e.source).toBe('batch')
    expect(e.message).toBe('boom')
    expect(e.at).toBeGreaterThanOrEqual(before)
    expect(e.at).toBeLessThanOrEqual(after)
  })

  it('carries an optional entityRef through unchanged', () => {
    useCamStore.getState().addConsoleEvent({
      severity: 'warning', source: 'sketch', message: 'linked',
      entityRef: { kind: 'op', id: 'op-1' },
    })
    expect(useCamStore.getState().consoleEvents[0].entityRef).toEqual({ kind: 'op', id: 'op-1' })
  })

  it('(b) the ring cap evicts the oldest entries — removing the cap or the severity union breaks this by construction', () => {
    for (let i = 0; i < CONSOLE_EVENT_CAP + 10; i++) {
      useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message: `m${i}` })
    }
    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBe(CONSOLE_EVENT_CAP)
    // The oldest 10 (m0..m9) were evicted; the buffer keeps the newest CAP entries.
    expect(events[0].message).toBe('m10')
    expect(events[events.length - 1].message).toBe(`m${CONSOLE_EVENT_CAP + 9}`)
  })

  it('the cap is at least 200 per the WO spec', () => {
    expect(CONSOLE_EVENT_CAP).toBeGreaterThanOrEqual(200)
  })
})

describe('clearConsoleEvents', () => {
  it('(c) empties the log and resets the read marker', () => {
    useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'app', message: 'x' })
    useCamStore.getState().markConsoleRead()
    expect(useCamStore.getState().consoleReadThroughId).toBeGreaterThan(0)

    useCamStore.getState().clearConsoleEvents()
    expect(useCamStore.getState().consoleEvents).toEqual([])
    expect(useCamStore.getState().consoleReadThroughId).toBe(0)
  })
})

describe('selectUnreadConsoleErrorCount', () => {
  it('(d) counts errors appended since the last markConsoleRead', () => {
    useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message: 'ok' })
    useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'app', message: 'e1' })
    expect(selectUnreadConsoleErrorCount(useCamStore.getState())).toBe(1)

    useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'app', message: 'e2' })
    expect(selectUnreadConsoleErrorCount(useCamStore.getState())).toBe(2)

    // markConsoleRead (BottomConsole expand) marks everything seen so far.
    useCamStore.getState().markConsoleRead()
    expect(selectUnreadConsoleErrorCount(useCamStore.getState())).toBe(0)

    // A NEW error after the mark is unread again; a non-error after it is not counted.
    useCamStore.getState().addConsoleEvent({ severity: 'success', source: 'app', message: 'ok2' })
    useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'app', message: 'e3' })
    expect(selectUnreadConsoleErrorCount(useCamStore.getState())).toBe(1)
  })

  it('starts at 0 with an empty log', () => {
    expect(selectUnreadConsoleErrorCount(useCamStore.getState())).toBe(0)
  })
})
