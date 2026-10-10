import type { Project, Setup } from '../../../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, move, stampGenerationCurrent } from '../../helpers'

export function vendorJob(): Project {
  const tools = [makeTool({ id: 't1', toolNumber: 1 }), makeTool({ id: 't2', toolNumber: 2 })]
  for (const tool of tools) tool.feedsAndSpeeds.default.feedRate = 2012.3456
  const operations = tools.map((tool, index) => makeOp({
    id: `op-${index}`, name: `Vendor import cut ${index + 1}`, toolId: tool.id,
    toolpathMoves: [
      move({ type: 'rapid', x: 25.41234, y: 0, z: 10, role: 'rapid' }),
      move({ type: 'feed', x: 25.41234, y: 0, z: -1, feed: 400, role: 'cut' }),
      ...Array.from({ length: 37 }, (_, i) => {
        const angle = i * Math.PI / 72
        return move({ type: 'feed', x: 25.41234 * Math.cos(angle), y: 25.41234 * Math.sin(angle), z: -1, feed: 2012.3456, role: 'cut' })
      }),
    ],
  }))
  const setup: Setup = { id: 'vendor-setup', name: 'Import verification', wcs: makeWcs(), stock: makeStock(), operations, notes: '' }
  const project: Project = {
    id: 'vendor-job', name: 'Vendor import verification', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine(), toolLibrary: tools, geometry: [], setups: [setup],
    activeSetupId: setup.id, activeOperationId: operations[0].id, sceneStock: {} as Project['sceneStock'], notes: '',
  }
  operations.forEach((op, i) => stampGenerationCurrent(project, setup, op, tools[i]))
  return project
}
