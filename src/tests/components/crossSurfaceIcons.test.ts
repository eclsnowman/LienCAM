import { describe, it, expect } from 'vitest'
import { TOOL_ICONS } from '../../lib/sketch/sketcher/overlays/SketchPromptBar'
import { SECTIONS as CAM_SECTIONS } from '../../components/panels/sketch/SketchToolbox'
import { SKETCH_SECTIONS as WORKBENCH_SECTIONS } from '../../components/model3d/workbench/WorkbenchToolRail'
import { ARMABLE_TOOLS, type SketchToolId } from '../../lib/sketch/tools/toolMachine'

describe('WO-052: cross-surface tool icon identity', () => {
  it('prompt bar maps an icon component for every armable tool ID + select', () => {
    const allTools: SketchToolId[] = ['select', ...Array.from(ARMABLE_TOOLS)]
    for (const toolId of allTools) {
      const icon = TOOL_ICONS[toolId]
      expect(icon, `Prompt bar missing icon for tool ${toolId}`).toBeDefined()
    }
  })

  it('CAM toolbox and prompt bar resolve the exact same icon component per tool', () => {
    const camToolIcons = new Map<string, unknown>()
    for (const section of CAM_SECTIONS) {
      for (const tool of section.tools) {
        camToolIcons.set(tool.id, tool.icon)
      }
    }

    for (const [toolId, promptIcon] of Object.entries(TOOL_ICONS)) {
      const camIcon = camToolIcons.get(toolId)
      if (camIcon) {
        expect(camIcon, `CAM toolbox and prompt bar disagree on icon component for ${toolId}`).toBe(promptIcon)
      }
    }
  })

  it('Workbench rail and prompt bar resolve the exact same icon component per tool', () => {
    const workbenchToolIcons = new Map<string, unknown>()
    for (const section of WORKBENCH_SECTIONS) {
      for (const tool of section.tools) {
        workbenchToolIcons.set(tool.id, tool.icon)
      }
    }

    for (const [toolId, promptIcon] of Object.entries(TOOL_ICONS)) {
      const wbIcon = workbenchToolIcons.get(toolId)
      if (wbIcon) {
        expect(wbIcon, `Workbench rail and prompt bar disagree on icon component for ${toolId}`).toBe(promptIcon)
      }
    }
  })
})
