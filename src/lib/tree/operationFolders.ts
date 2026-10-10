import type { OperationFolder } from '../../types'

/** Return a folder and all nested descendants without assuming input order. */
export function collectOperationFolderTreeIds(
  folders: readonly OperationFolder[],
  rootId: string,
): Set<string> {
  const ids = new Set<string>([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const folder of folders) {
      if (folder.parentId != null && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        grew = true
      }
    }
  }
  return ids
}
