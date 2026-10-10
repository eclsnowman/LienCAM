import type { Tool, ToolHolder } from '../../types'

// One row per tool. Feeds and speeds come from the 'default' entry, else the first
// entry the tool carries; the `fs_material` column says which one was used.
export const TOOL_CSV_COLUMNS = [
  'name', 'type', 'diameter_mm', 'flutes', 'fs_material',
  'rpm', 'feed_mm_min', 'plunge_mm_min', 'depth_of_cut_mm', 'stepover_mm',
  'holder',
] as const

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toolLibraryToCsv(tools: Tool[], holders: ToolHolder[]): string {
  const rows: string[] = [TOOL_CSV_COLUMNS.join(',')]
  for (const t of tools) {
    const fsKey = t.feedsAndSpeeds?.default ? 'default' : Object.keys(t.feedsAndSpeeds ?? {})[0]
    const fs = fsKey ? t.feedsAndSpeeds[fsKey] : undefined
    const holder = t.holderId ? holders.find(h => h.id === t.holderId)?.name : undefined
    rows.push([
      t.name, t.type, t.diameter, t.numberOfFlutes, fsKey,
      fs?.rpm, fs?.feedRate, fs?.plungeRate, fs?.depthOfCut, fs?.stepover,
      holder,
    ].map(csvCell).join(','))
  }
  return rows.join('\r\n') + '\r\n'
}
