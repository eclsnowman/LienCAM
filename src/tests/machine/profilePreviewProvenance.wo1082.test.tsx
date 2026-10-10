// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfilePreviewView } from '../../components/machine/ProfilePreviewView'
import type { MachineDefinitionProvenance } from '../../lib/machine/controller'
import {
  importUccncProfile,
  previewProfileChanges,
  type BridgeProfilePreviewReply,
  type ProfilePreview,
} from '../../lib/machine/uccncProfileImport'
import { useCamStore } from '../../store'
import type { ControllerDefinition } from '../../types'

const PROFILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'),
  'utf8',
)

const OPERATOR_SOURCE = 'Operator, 2026-08-26 ladder'
const AXES = ['X', 'Y', 'Z', 'A'] as const

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function importedDefinition(): {
  definition: ControllerDefinition
  travel: { x: number; y: number; z: number }
  unsent: ReturnType<typeof importUccncProfile>['unsent']
} {
  const imported = importUccncProfile(PROFILE)
  if (!imported.definition || !imported.travel) throw new Error('LienCNCV2.pro did not import')
  return { definition: imported.definition, travel: imported.travel, unsent: imported.unsent }
}

function operatorProvenance(): MachineDefinitionProvenance {
  return Object.fromEntries(AXES.map((axis) => [
    `axes.${axis}.acceleration`,
    { kind: 'operator' as const, source: OPERATOR_SOURCE },
  ]))
}

function preview(args: {
  editedAxes?: readonly (typeof AXES)[number][]
  provenance?: MachineDefinitionProvenance
  bridgeReplaced?: BridgeProfilePreviewReply['replaced']
  mutateCurrent?: (current: ControllerDefinition) => void
} = {}): ProfilePreview {
  const imported = importedDefinition()
  const current = clone(imported.definition)
  for (const axis of args.editedAxes ?? AXES) {
    const row = current.axes.find((candidate) => candidate.axis === axis)
    if (!row) throw new Error(`profile has no ${axis} axis`)
    row.acceleration = 1000
  }
  args.mutateCurrent?.(current)
  const reply: BridgeProfilePreviewReply = {
    ok: true,
    error: null,
    path: 'C:\\UCCNC\\Profiles\\LienCNCV2.pro',
    profileName: 'LienCNCV2',
    board: { type: 'AXBB-E', pinTranslation: true },
    definition: imported.definition,
    travel: imported.travel,
    pins: [],
    unsent: imported.unsent,
    warnings: [],
    replaced: args.bridgeReplaced,
  }
  return previewProfileChanges({
    name: 'LienCNC V2',
    controllerDefinition: current,
    travel: imported.travel,
    unsentSettings: imported.unsent,
    definitionProvenance: args.provenance,
  }, reply)
}

afterEach(() => {
  cleanup()
  useCamStore.getState().clearConsoleEvents()
})

describe('WO-1082 re-import replacement provenance', () => {
  it('names all four operator accelerations and leaves the receipt to the successful writer', () => {
    const result = preview({ provenance: operatorProvenance() })
    const onConfirm = vi.fn()
    render(<ProfilePreviewView preview={result} onConfirm={onConfirm} onCancel={() => {}} />)

    const marked = screen.getAllByText('you set this - will be replaced')
    expect(marked).toHaveLength(4)
    expect(marked.map((status) => status.closest('tr')?.getAttribute('data-testid'))).toEqual([
      'uccnc-profile-change-axis.X.acceleration',
      'uccnc-profile-change-axis.Y.acceleration',
      'uccnc-profile-change-axis.Z.acceleration',
      'uccnc-profile-change-axis.A.acceleration',
    ])
    expect(marked[0].getAttribute('data-tooltip')).toContain(`operator: ${OPERATOR_SOURCE}`)
    expect(screen.getByTestId('uccnc-profile-replacement-summary').textContent).toContain(
      'Re-importing LienCNCV2.pro will replace 4 values you set yourself, '
      + 'including X acceleration 1000 -> 500.',
    )

    fireEvent.click(screen.getByTestId('uccnc-profile-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    const receipts = useCamStore.getState().consoleEvents.filter(
      (event) => event.message.includes('Re-imported LienCNCV2.pro'),
    )
    expect(receipts).toHaveLength(0)
  })

  it('shows no summary without provenance and never lists a provenanced equal value', () => {
    const unprovenanced = preview({ provenance: {}, editedAxes: AXES })
    render(<ProfilePreviewView preview={unprovenanced} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.queryByTestId('uccnc-profile-replacement-summary')).toBeNull()
    expect(screen.queryByText('you set this - will be replaced')).toBeNull()
    cleanup()

    const oneEqual = preview({ provenance: operatorProvenance(), editedAxes: ['Y', 'Z', 'A'] })
    render(<ProfilePreviewView preview={oneEqual} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getAllByText('you set this - will be replaced')).toHaveLength(3)
    expect(screen.getByTestId('profile-preview-status-change-axis.X.acceleration').textContent)
      .toBe('same')
  })

  it('names backlash values using the exact provenance keys WO-1073 emits', () => {
    const mutateBacklash = (current: ControllerDefinition) => {
      const x = current.axes.find((axis) => axis.axis === 'X')
      if (!x) throw new Error('profile has no X axis')
      x.backlash.enabled = !x.backlash.enabled
      x.backlash.distance += 0.25
    }
    const provenance: MachineDefinitionProvenance = {
      'axes.X.backlash.enabled': { kind: 'operator', source: OPERATOR_SOURCE },
      'axes.X.backlash.distance': { kind: 'operator', source: OPERATOR_SOURCE },
    }
    const result = preview({ editedAxes: [], provenance, mutateCurrent: mutateBacklash })

    expect(result.replacements?.map(({ key }) => key)).toEqual([
      'axis.X.backlashEnabled',
      'axis.X.backlashDistance',
    ])
    expect(result.changes.filter(({ replacement }) => replacement).map(({ key }) => key)).toEqual([
      'axis.X.backlashEnabled',
      'axis.X.backlashDistance',
    ])
    render(<ProfilePreviewView preview={result} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getAllByText('you set this - will be replaced').map(
      (status) => status.closest('tr')?.getAttribute('data-testid'),
    )).toEqual([
      'uccnc-profile-change-axis.X.backlashEnabled',
      'uccnc-profile-change-axis.X.backlashDistance',
    ])
    cleanup()

    const bridgeResult = preview({
      editedAxes: [],
      provenance: {},
      mutateCurrent: mutateBacklash,
      bridgeReplaced: [{
        key: 'axes.X.backlash.distance',
        ours: '0.25',
        profile: '0',
        provenance: { kind: 'operator', source: OPERATOR_SOURCE },
      }],
    })
    expect(bridgeResult.replacements?.map(({ key }) => key)).toEqual([
      'axis.X.backlashDistance',
    ])
    expect(bridgeResult.changes.find(({ key }) => key === 'axis.X.backlashDistance')?.replacement)
      .toMatchObject({ key: 'axis.X.backlashDistance', source: 'bridge' })
  })

  it("uses and names the bridge's replaced list when it differs from the app's", () => {
    const result = preview({
      provenance: operatorProvenance(),
      bridgeReplaced: [{
        key: 'axes.X.acceleration',
        ours: '1000',
        profile: '500',
        provenance: { kind: 'operator', source: 'bridge cache: Operator ladder' },
      }],
    })
    render(<ProfilePreviewView preview={result} onConfirm={() => {}} onCancel={() => {}} />)

    expect(screen.getAllByText('you set this - will be replaced')).toHaveLength(1)
    const summary = screen.getByTestId('uccnc-profile-replacement-summary')
    expect(summary.getAttribute('data-source')).toBe('bridge')
    expect(summary.textContent).toContain("The bridge's list differs from this app's provenance")
    expect(screen.getByTestId('profile-preview-status-change-axis.X.acceleration')
      .getAttribute('data-tooltip')).toContain('bridge cache: Operator ladder')
  })
})
