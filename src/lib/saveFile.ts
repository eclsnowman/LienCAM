import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// One way every Save / Export in the app writes a file.
//
// Operator 09-25 at the machine: Export .nc did nothing in the desktop app - no file, no
// dialog, no error. Every download site clicked a blob link and revoked the blob in
// the same tick; the desktop app starts the download later and found it gone. In the
// desktop app the bytes now go to the host, which asks where to save them. In a
// browser the link stays valid long enough for the download to start.

type SaveHost = { saveFile?: (filename: string, data: string | Uint8Array) => Promise<string | null> }

const BROWSER_REVOKE_DELAY_MS = 60_000

/** Keep a file component readable while making it safe on Windows. */
export function safeFilenameComponent(name: string, fallback: string): string {
  const clean = Array.from(name, char => char.charCodeAt(0) < 32 ? '-' : char)
    .join('').replace(/[<>:"/\\|?*]/g, '-').trim().replace(/[. ]+$/g, '')
  if (!clean) return fallback
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean
}

/** Keep project/body names readable while making each component safe on Windows. */
export function modelExportFilename(projectName: string, format: 'step' | 'stl', bodyName?: string): string {
  const project = safeFilenameComponent(projectName, operatorText('saveFile1'))
  return `${project}${bodyName === undefined ? '' : `-${safeFilenameComponent(bodyName, operatorText('saveFile2'))}`}.${format}`
}

/** Resolves to where the file went ('download' in a browser), or null if the operator cancelled.
 *  The browser path runs synchronously, so a refused download throws to the caller at once. */
export function saveFile(filename: string, contents: string | Blob, mimeType = 'application/octet-stream'): Promise<string | null> {
  const host = (globalThis as typeof globalThis & { liencamHost?: SaveHost }).liencamHost
  const hostSave = host?.saveFile
  if (typeof hostSave === 'function') {
    return (async () => {
      const data = typeof contents === 'string' ? contents : new Uint8Array(await contents.arrayBuffer())
      return hostSave(filename, data)
    })()
  }
  const blob = typeof contents === 'string' ? new Blob([contents], { type: mimeType }) : contents
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), BROWSER_REVOKE_DELAY_MS)
  return Promise.resolve('download')
}
