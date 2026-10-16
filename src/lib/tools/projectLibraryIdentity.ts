import type { Tool, ToolLibrary } from '../../types'
import { normalizeToolCutHand } from '../tool/cutHand'
import { DEFAULT_TOOL_LIBRARY_ID } from '../../store/migrations/projectMigrations'

// IDs identify records, not cutter content. Include every other stored field,
// including feeds, tool numbers and resolved holder IDs. Export property order
// must not turn an identical cutter into another copy.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v)
}

// WO-2882: an opened file's tools are migrated (cutHand backfilled to
// 'right'); a library record without the field is the same cutter.
// WO-2882: a record without a libraryId lives in the default library, exactly
// as rehydrate and the project-file migration file it.
const inLibrary = (tool: Tool, libraryId: string | undefined) =>
  (tool.libraryId ?? DEFAULT_TOOL_LIBRARY_ID) === (libraryId ?? DEFAULT_TOOL_LIBRARY_ID)

function toolKey({ id: _id, libraryId: _libraryId, ...content }: Tool): string {
  return canonical({ ...content, cutHand: normalizeToolCutHand(content.cutHand) })
}

/** Project files embed only USED tools (buildProjectFileSnapshot), so two
 * exports of the same named library need not contain the same complete set.
 * Reuse identical members and add compatible members. A differing version of
 * a named cutter keeps its own library. Never edit/delete existing records.
 * Holders must already have been resolved by WO-1440's content-aware merge. */
export function reuseProjectLibraries(
  libraries: readonly ToolLibrary[],
  tools: readonly Tool[],
  incomingLibraries: readonly ToolLibrary[],
  incomingTools: readonly Tool[],
  postedNumbers: Readonly<Record<string, number>> = {},
) {
  const availableLibraries = [...libraries]
  const availableTools = [...tools]
  const added: ToolLibrary[] = []
  const addedTools: Tool[] = []
  const libraryRemap = new Map<string, string>()
  const toolRemap = new Map<string, string>()
  const assignedInFile = new Map<string, number | undefined>()

  const mergeTool = (incoming: Tool, libraryId = incoming.libraryId) => {
    const key = toolKey(incoming)
    const postedNumber = postedNumbers[incoming.id] ?? incoming.toolNumber
    const existing = availableTools.find(t => inLibrary(t, libraryId) && toolKey(t) === key &&
      (!assignedInFile.has(t.id) || assignedInFile.get(t.id) === postedNumber))
    if (existing) {
      assignedInFile.set(existing.id, postedNumber)
      if (existing.id !== incoming.id) toolRemap.set(incoming.id, existing.id)
      return
    }
    let id = incoming.id
    const collision = availableTools.find(t => t.id === id)
    if (collision) {
      // WO-1440's stable holder-derived ID is preserved. Other content
      // collisions also get their own identity rather than using shop edits.
      id = incoming.holderId && collision.holderId !== incoming.holderId
        ? `${id}@${incoming.holderId}` : libraryId ? `${id}@${libraryId}` : crypto.randomUUID()
      while (availableTools.some(t => t.id === id)) id = crypto.randomUUID()
      toolRemap.set(incoming.id, id)
    }
    const tool = { ...incoming, id, ...(libraryId ? { libraryId } : {}) }
    addedTools.push(tool)
    availableTools.push(tool)
    assignedInFile.set(id, postedNumber)
  }

  const groupedTools = new Set<string>()
  for (const library of incomingLibraries) {
    if (!library) continue
    const members = incomingTools.filter(t => t?.libraryId === library.id)
    const candidates = availableLibraries.filter(candidate => {
      if (candidate.name !== library.name) return false
      const existing = availableTools.filter(t => inLibrary(t, candidate.id))
      return members.every(member => {
        const named = existing.filter(t => t.name === member.name)
        return named.length === 0 || named.some(t => toolKey(t) === toolKey(member))
      })
    })
    // Prefer the claimed identity when compatible, then the collection that
    // shares the most members. Pre-existing duplicates are left untouched.
    candidates.sort((a, b) => Number(b.id === library.id) - Number(a.id === library.id) ||
      members.filter(m => availableTools.some(t => inLibrary(t, b.id) && toolKey(t) === toolKey(m))).length -
      members.filter(m => availableTools.some(t => inLibrary(t, a.id) && toolKey(t) === toolKey(m))).length)
    let target = candidates[0]
    if (!target) {
      let id = library.id
      while (availableLibraries.some(l => l.id === id)) id = crypto.randomUUID()
      target = id === library.id ? library : { ...library, id }
      added.push(target)
      availableLibraries.push(target)
    }
    if (library.id !== target.id) libraryRemap.set(library.id, target.id)
    for (const member of members) {
      groupedTools.add(member.id)
      mergeTool(member, target.id)
    }
  }
  // Legacy files may carry tools without a corresponding definition.
  for (const tool of incomingTools) if (tool && !groupedTools.has(tool.id)) mergeTool(tool)
  return { added, addedTools, libraryRemap, toolRemap }
}
