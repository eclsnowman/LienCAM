// @vitest-environment jsdom
//
// WO-2399 - Help explains how to connect LienCAM to LinuxCNC. Opens the Help
// centre through its production component, searches the way a user would, and
// reads the topic the user lands on.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { HelpCenterModal } = await import('../../components/modals/HelpCenterModal')
const { useCamStore } = await import('../../store')
const { useHelpOpen, openHelpTopic } = await import('../../help/helpOpen')
const { helpIndexEntry, loadTopic } = await import('../../help/registry')

describe('WO-2399: Help topic "Connecting to LinuxCNC"', () => {
  beforeEach(() => {
    useCamStore.setState({ activeModal: null, consoleEvents: [], consoleReadThroughId: 0 })
    useHelpOpen.setState({ requested: null, overlay: false })
  })
  afterEach(() => cleanup())

  for (const word of ['linuxcnc', 'gateway', 'network']) {
    it(`searching "${word}" finds the topic`, async () => {
      render(<HelpCenterModal />)
      act(() => { openHelpTopic('control-connect') })
      const box = await screen.findByTestId('help-search')
      fireEvent.change(box, { target: { value: word } })
      expect(await screen.findByTestId('help-topic-connect-linuxcnc')).toBeTruthy()
    })
  }

  it('opens with the five parts, the real commands and the hardware caveat', async () => {
    render(<HelpCenterModal />)
    act(() => { openHelpTopic('connect-linuxcnc') })
    const article = await screen.findByTestId('help-topic-content')
    await screen.findByTestId('help-anchor-linuxcnc-tested')
    const text = article.textContent ?? ''
    for (const anchor of ['linuxcnc-pc', 'linuxcnc-start', 'linuxcnc-in-liencam', 'linuxcnc-different', 'linuxcnc-tested']) {
      expect(screen.getByTestId(`help-anchor-${anchor}`), anchor).toBeTruthy()
    }
    expect(text).toContain('python3 gateway.py --host 0.0.0.0')
    expect(text).toContain('8327')
    expect(text).toContain('--port')
    expect(text).toContain('--program-dir')
    expect(text).toContain('LinuxCNC PC address')
    expect(text).toContain('LinuxCNC gateway')
    expect(text).toContain('G38')
    expect(text).toContain('M6')
    expect(text).toContain('tested against simulators (grbl-sim and the LinuxCNC simulator)')
  })

  it('"Connecting to the machine" is related to it and names LinuxCNC', async () => {
    const connect = await loadTopic('control-connect')
    expect(connect!.relatedTopicIds).toContain('connect-linuxcnc')
    expect(helpIndexEntry('control-connect')!.summary).toMatch(/LinuxCNC/)
    expect(helpIndexEntry('control-connect')!.keywords).toMatch(/linuxcnc/)
    expect(helpIndexEntry('connect-linuxcnc')?.category).toBe('machine')
  })

  it('the topic is plain ASCII', async () => {
    const topic = await loadTopic('connect-linuxcnc')
    // eslint-disable-next-line no-control-regex
    expect(JSON.stringify(topic)).toMatch(/^[\x00-\x7f]*$/)
  })
})
