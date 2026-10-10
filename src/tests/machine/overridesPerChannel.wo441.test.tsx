// @vitest-environment jsdom
// An override channel a controller does not HAVE must read as absent, never as
// 100%. The AXBB-E has feed and spindle overrides but no rapid one at all.
//
// Found in architect review: machineSession collapsed the WHOLE overrides
// object to null if any single channel was null, and the store then kept its
// previous value - so on that controller the feed and spindle overrides it DOES
// report were discarded and the panel sat frozen at 100%, silently ignoring the
// operator. Worse than the rapid lie it was hiding.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { OverridePanel } from '../../components/machine/OverridePanel'
import {
  useMachineControl,
  type OverrideAvailabilityState,
} from '../../store/machineControlStore'

function connectWithOverrides(overrides: {
  feed: number | null
  rapid: number | null
  spindle: number | null
}) {
  const overrideAvailability: OverrideAvailabilityState = {
    feed: overrides.feed === null ? 'unsupported' : 'supported',
    rapid: overrides.rapid === null ? 'unsupported' : 'supported',
    spindle: overrides.spindle === null ? 'unsupported' : 'supported',
  }
  useMachineControl.setState({ connectionPhase: 'connected', overrides, overrideAvailability })
}

describe('override channels a controller does not have', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    useMachineControl.setState({
      connectionPhase: 'disconnected',
      overrides: { feed: null, rapid: null, spindle: null },
      overrideAvailability: { feed: 'unknown', rapid: 'unknown', spindle: 'unknown' },
    })
  })

  it('keeps reporting feed and spindle when only rapid is missing', () => {
    // The whole point: one absent channel must not discard the other two.
    connectWithOverrides({ feed: 75, rapid: null, spindle: 120 })
    render(<OverridePanel />)

    expect(screen.getByTestId('control-ovr-rapid-absent')).toBeTruthy()
    const unavailableRapid = screen.getByTestId('control-ovr-rapid')
    expect(unavailableRapid.tagName).toBe('SPAN')
    expect(unavailableRapid.querySelector('button, input')).toBeNull()
    // feed and spindle still have live steppers
    expect(screen.queryByTestId('control-ovr-feed-absent')).toBeNull()
    expect(screen.queryByTestId('control-ovr-spindle-absent')).toBeNull()
  })

  it('says so rather than showing a number for an absent channel', () => {
    connectWithOverrides({ feed: 100, rapid: null, spindle: 100 })
    render(<OverridePanel />)

    const absent = screen.getByTestId('control-ovr-rapid-absent')
    expect(absent.textContent).toContain('not on this controller')
    expect(absent.textContent).not.toContain('100')
  })

  // Caught by LOOKING at the WO-448 capture: the Control page's off-nominal
  // override flag read `rapid !== 100`, which is true for null, so it rendered
  // the literal text "Rnull%" on a real bridge session. A null channel is
  // absent, not off-nominal.
  it('never renders a null channel as an off-nominal override chip', async () => {
    const { ControlPage } = await import('../../components/machine/ControlPage')
    connectWithOverrides({ feed: 100, rapid: null, spindle: 100 })
    render(<ControlPage />)

    // feed and spindle are nominal, rapid is absent - so there is nothing to flag
    expect(screen.queryByTestId('control-override-flag')).toBeNull()
    expect(document.body.textContent).not.toContain('null')
  })

  it('flags a real off-nominal channel while ignoring an absent one', async () => {
    const { ControlPage } = await import('../../components/machine/ControlPage')
    connectWithOverrides({ feed: 75, rapid: null, spindle: 100 })
    render(<ControlPage />)

    const flag = screen.getByTestId('control-override-flag')
    expect(flag.textContent).toContain('F75%')
    expect(flag.textContent).not.toContain('R')
    expect(flag.textContent).not.toContain('null')
  })

  it('shows every channel when the controller has them all', () => {
    connectWithOverrides({ feed: 100, rapid: 100, spindle: 100 })
    render(<OverridePanel />)

    expect(screen.getByTestId('control-ovr-rapid')).toBeTruthy()
    expect(screen.queryByTestId('control-ovr-rapid-absent')).toBeNull()
  })

  it('shows supported channels as waiting until this session reports a value', () => {
    useMachineControl.setState({
      connectionPhase: 'connected',
      overrides: { feed: null, rapid: null, spindle: null },
      overrideAvailability: { feed: 'supported', rapid: 'supported', spindle: 'supported' },
    })
    render(<OverridePanel />)

    expect(screen.getByTestId('control-ovr-feed-waiting').textContent).toContain('waiting for report')
    expect(screen.getByTestId('control-ovr-rapid-waiting').textContent).toContain('waiting for report')
    expect(screen.getByTestId('control-ovr-spindle-waiting').textContent).toContain('waiting for report')
    expect(screen.queryByRole('button', { name: /rapid override/i })).toBeNull()
    expect(screen.queryByRole('spinbutton', { name: /override percent/i })).toBeNull()
  })
})
