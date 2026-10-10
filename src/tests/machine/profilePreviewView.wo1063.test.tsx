// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProfilePreviewView } from '../../components/machine/ProfilePreviewView'
import { topics as settingsHelpTopics } from '../../help/topics/settings'
import type {
  ProfileChangeRow,
  ProfilePinRow,
  ProfilePreview,
} from '../../lib/machine/uccncProfileImport'

const pin = (overrides: Partial<ProfilePinRow> & Pick<ProfilePinRow, 'key'>): ProfilePinRow => {
  const { key, ...rest } = overrides
  return {
    key,
    group: 'X axis',
    label: key,
    rawBefore: 'port 1 pin 1, not inverted',
    rawAfter: 'port 1 pin 1, not inverted',
    boardBefore: 'UCpin 101',
    boardAfter: 'UCpin 101',
    state: 'unchanged',
    changed: false,
    translationOnly: false,
    outcome: `Exact explanation for ${key}.`,
    ...rest,
  }
}

const change = (
  overrides: Partial<ProfileChangeRow> & Pick<ProfileChangeRow, 'key'>,
): ProfileChangeRow => {
  const { key, ...rest } = overrides
  return {
    key,
    group: 'Travel',
    label: key,
    before: '10',
    after: '10',
    changed: false,
    ...rest,
  }
}

function preview(overrides: Partial<ProfilePreview> = {}): ProfilePreview {
  return {
    readable: true,
    path: 'C:\\UCCNC\\Profiles\\Shop.pro',
    profileName: 'Shop',
    error: null,
    board: { type: 'AXBB-E', pinTranslation: true },
    pins: [
      pin({ key: 'same' }),
      pin({
        key: 'changes',
        rawAfter: 'port 1 pin 2, not inverted',
        boardAfter: 'UCpin 102',
        state: 'changed',
        changed: true,
      }),
      pin({
        key: 'new',
        rawBefore: 'not in this machine',
        boardBefore: 'not in this machine',
        rawAfter: 'port 2 pin 2, not inverted',
        boardAfter: 'UCpin 202',
        state: 'changed',
        changed: true,
      }),
      pin({
        key: 'unreadable',
        boardAfter: 'cannot be translated on this board',
        state: 'untranslatable',
        outcome: 'The bridge cannot verify this result.',
      }),
    ],
    changes: [
      change({ key: 'same-setting' }),
      change({ key: 'changed-setting', before: '10', after: '20', changed: true }),
      change({
        key: 'new-setting', before: 'not in this machine', after: 'enabled', changed: true,
      }),
    ],
    changedCount: 4,
    translationOnlyCount: 0,
    refusals: [],
    warnings: [],
    definition: null,
    travel: null,
    unsent: [],
    ...overrides,
  }
}

afterEach(cleanup)

describe('WO-1063 full-height profile preview', () => {
  it('owns the review actions, row count, and keyboard-scrollable body', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ProfilePreviewView preview={preview()} onConfirm={onConfirm} onCancel={onCancel} />)

    expect(screen.getByTestId('uccnc-profile-preview').getAttribute('data-row-count')).toBe('7')
    expect(screen.getByTestId('uccnc-profile-row-count').textContent).toContain('7 rows')
    expect(screen.getByTestId('profile-preview-scroll').getAttribute('tabindex')).toBe('0')

    fireEvent.click(screen.getByTestId('uccnc-profile-confirm'))
    fireEvent.click(screen.getByTestId('uccnc-profile-cancel'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('puts changed rows first and gives every row one compact status with its explanation in a tooltip', () => {
    render(<ProfilePreviewView preview={preview()} onConfirm={() => {}} onCancel={() => {}} />)

    const pinRows = [...document.querySelectorAll<HTMLElement>('[data-testid^="uccnc-profile-pin-"]')]
    expect(pinRows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'uccnc-profile-pin-changes',
      'uccnc-profile-pin-new',
      'uccnc-profile-pin-same',
      'uccnc-profile-pin-unreadable',
    ])
    const settingRows = [...document.querySelectorAll<HTMLElement>('[data-testid^="uccnc-profile-change-"]')]
      .filter((row) => row.tagName === 'TR')
    expect(settingRows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'uccnc-profile-change-changed-setting',
      'uccnc-profile-change-new-setting',
      'uccnc-profile-change-same-setting',
    ])

    expect(screen.getByTestId('profile-preview-status-pin-same').textContent).toBe('same')
    expect(screen.getByTestId('profile-preview-status-pin-changes').textContent).toBe('changes')
    expect(screen.getByTestId('profile-preview-status-pin-new').textContent).toBe('new')
    expect(screen.getByTestId('profile-preview-status-pin-unreadable').textContent).toBe('unreadable')

    for (const row of [...pinRows, ...settingRows]) {
      const status = row.querySelector<HTMLElement>('[data-status]')
      const explanation = status?.getAttribute('data-tooltip') ?? ''
      expect(explanation).not.toBe('')
      expect(row.textContent).not.toContain(explanation)
    }
  })

  it('offers no Confirm when the bridge could not produce a readable report', () => {
    render(
      <ProfilePreviewView
        preview={preview({ readable: false, error: 'Unreadable profile', pins: [], changes: [], changedCount: 0 })}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )

    expect(screen.queryByTestId('uccnc-profile-confirm')).toBeNull()
    expect(screen.getByTestId('uccnc-profile-unreadable').textContent)
      .toContain('Unreadable profile')
  })

  it('documents every profile status in the existing Machine Library Help topic', () => {
    const topic = settingsHelpTopics.find(({ id }) => id === 'machine-library')
    const helpText = topic?.sections.flatMap((section) => {
      if ('text' in section) return [section.text]
      if ('steps' in section) return section.steps
      return []
    }).join(' ') ?? ''

    expect(helpText).toContain('same (no change)')
    expect(helpText).toContain('changes (a different value would be written)')
    expect(helpText).toContain('new (the machine has no value for it yet)')
    expect(helpText).toContain('A file that cannot be read shows why, and nothing is changed')
  })
})
