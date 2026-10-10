import type { PostConfig } from './types'

// Download file extension chosen by CONTROLLER IDENTITY (the post dialect id),
// NOT by comment style. A GRBL config that uses parenthesis comments is still
// GRBL and must download as .gcode. This function only picks the FILENAME
// extension; it never touches the emitted g-code bytes.
//
//   GRBL      -> .gcode   (any comment style)
//   LinuxCNC  -> .ngc
//   other/custom fallback -> .nc
//
// Built-in dialect ids: 'grbl', 'linuxcnc', 'uccnc', 'generic'. User posts
// derived from a built-in keep no controller field today (they get 'user-...'
// ids), so a user-saved GRBL post falls to the .nc fallback until a controller
// identity is threaded onto user posts (tracked separately, out of this fix's
// scope).
export function extForConfig(c: PostConfig): string {
  if (c.id === 'grblhal') return 'nc'
  if (c.id.startsWith('grbl')) return 'gcode'
  if (c.id.startsWith('linuxcnc')) return 'ngc'
  return 'nc'
}

/**
 * Build the exact filename used by the Post Process modal's combined download.
 * Keeping sanitization and dialect extension selection in this production seam
 * prevents the tested helper from drifting away from the anchor download path.
 */
export function downloadFilenameForConfig(
  projectName: string | null | undefined,
  config: PostConfig,
): string {
  const trimmed = (projectName ?? '').trim()
  const baseName = (trimmed || 'program').replace(/\s+/g, '_')
  return `${baseName}.${extForConfig(config)}`
}
