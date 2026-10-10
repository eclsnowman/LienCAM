// @vitest-environment jsdom
/**
 * WO-1751: GRBL and grblHAL declarations share one controller family. The
 * settings summary must therefore read the same definition-backed $27 and
 * $130-$132 facts for either declaration, without a device-specific branch.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDefaultControllerDefinition,
  type ControllerType,
  type MachineConfig,
} from '../../types'

const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

const originalProject = useCamStore.getState().project

function grblFamilyMachine(controller: Extract<ControllerType, 'grbl' | 'grblhal'>): MachineConfig {
  const definition = createDefaultControllerDefinition()
  return {
    ...originalProject.machine,
    id: `wo1751-${controller}`,
    name: controller === 'grbl' ? 'Bench GRBL' : 'Bench grblHAL',
    controller,
    travel: { x: 510, y: 405, z: 92 },
    grblSettings: { 27: '2.25', 130: '510', 131: '405', 132: '92' },
    controllerDefinition: {
      ...definition,
      axes: definition.axes.map((axis) => {
        const travel = axis.axis === 'X' ? 510 : axis.axis === 'Y' ? 405 : 92
        return { ...axis, softLimitMin: -travel, softLimitMax: 0 }
      }),
      homing: {
        ...definition.homing,
        perAxis: Object.fromEntries(Object.entries(definition.homing.perAxis)
          .map(([axis, homing]) => [axis, { ...homing!, backOff: 2.25 }])),
      },
    },
  }
}

function summaryFor(machine: MachineConfig): { homing: string; limits: string } {
  act(() => useCamStore.setState({ project: { ...originalProject, machine } }))
  render(<SettingsModal />)
  act(() => useCamStore.getState().openModal('settings'))
  return {
    homing: screen.getByText('Homing order / back-off').closest('tr')!.textContent ?? '',
    limits: screen.getByText('Per-axis soft limits').closest('tr')!.textContent ?? '',
  }
}

beforeEach(() => {
  useMachineControl.setState({ connectionKind: 'serial', settings: {} })
})

afterEach(() => {
  act(() => useCamStore.getState().closeModal())
  cleanup()
  useCamStore.setState({ project: originalProject })
  useMachineControl.setState({ connectionKind: null, settings: {} })
})

describe('WO-1751 GRBL-family settings summary', () => {
  it.each(['grbl', 'grblhal'] as const)(
    '%s shows definition-backed GRBL travel and back-off facts',
    (controller) => {
      const { homing, limits } = summaryFor(grblFamilyMachine(controller))

      expect(limits).toContain('X -510..0')
      expect(limits).toContain('Y -405..0')
      expect(limits).toContain('Z -92..0')
      expect(limits).not.toContain('not stated')
      expect(homing).toContain('X 2.25')
      expect(homing).toContain('Y 2.25')
      expect(homing).toContain('Z 2.25')
      expect(homing).not.toContain('not stated')
    },
  )
})
