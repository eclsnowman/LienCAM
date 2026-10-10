// programLibrary - recent post-processed programs, persisted in the browser's
// origin-private file system (OPFS) so they survive reloads without touching
// the user's disk. Every program loaded into the Control tab (posted setup or
// opened file) is saved here automatically; the picker lists them newest
// first. Capped - oldest entries are evicted. Degrades to a no-op (empty
// list) where OPFS is unavailable (e.g. jsdom); never throws at callers.

export interface RecentProgramMeta {
  id: string
  name: string
  /** Program size in characters. */
  size: number
  savedAt: number
}

const DIR_NAME = 'machine-programs'
const INDEX_FILE = 'index.json'
const MAX_ENTRIES = 12

export function programLibrarySupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  )
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  if (!programLibrarySupported()) return null
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(DIR_NAME, { create: true })
  } catch {
    return null
  }
}

async function readIndex(d: FileSystemDirectoryHandle): Promise<RecentProgramMeta[]> {
  try {
    const fh = await d.getFileHandle(INDEX_FILE)
    const file = await fh.getFile()
    const parsed: unknown = JSON.parse(await file.text())
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is RecentProgramMeta =>
        !!e && typeof e.id === 'string' && typeof e.name === 'string' && typeof e.savedAt === 'number',
    )
  } catch {
    return []
  }
}

async function writeIndex(d: FileSystemDirectoryHandle, entries: RecentProgramMeta[]): Promise<void> {
  const fh = await d.getFileHandle(INDEX_FILE, { create: true })
  const w = await fh.createWritable()
  await w.write(JSON.stringify(entries))
  await w.close()
}

export async function listPrograms(): Promise<RecentProgramMeta[]> {
  const d = await dir()
  if (!d) return []
  const entries = await readIndex(d)
  return entries.sort((a, b) => b.savedAt - a.savedAt)
}

export async function saveProgram(name: string, text: string): Promise<void> {
  const d = await dir()
  if (!d) return
  try {
    const entries = await readIndex(d)
    // Re-saving the same name replaces the old entry (a re-post of the same
    // setup should not fill the list with duplicates).
    const existing = entries.find((e) => e.name === name)
    const id = existing?.id ?? `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
    const fh = await d.getFileHandle(`${id}.nc`, { create: true })
    const w = await fh.createWritable()
    await w.write(text)
    await w.close()
    const next = entries.filter((e) => e.id !== id)
    next.push({ id, name, size: text.length, savedAt: Date.now() })
    next.sort((a, b) => b.savedAt - a.savedAt)
    // Evict beyond the cap - remove files best-effort.
    for (const evicted of next.slice(MAX_ENTRIES)) {
      try {
        await d.removeEntry(`${evicted.id}.nc`)
      } catch {
        // already gone - eviction is best-effort
      }
    }
    await writeIndex(d, next.slice(0, MAX_ENTRIES))
  } catch {
    // Persistence is a convenience; failing to save must never break loading.
  }
}

export async function readProgram(id: string): Promise<string | null> {
  const d = await dir()
  if (!d) return null
  try {
    const fh = await d.getFileHandle(`${id}.nc`)
    const file = await fh.getFile()
    return await file.text()
  } catch {
    return null
  }
}
