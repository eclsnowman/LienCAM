import { askBeforeReplacingProject, useCamStore } from '../../store'
import { projectHost, projectThumbnail, rememberProject } from './host'

/** Return the opened identity only on successful replacement. Cancel keeps the picker open. */
export async function openProjectText(text: string, path?: string): Promise<string | undefined> {
  if (!await askBeforeReplacingProject('open')) return
  return loadConfirmedProjectText(text, path)
}

async function loadConfirmedProjectText(text: string, path?: string): Promise<string | undefined> {
  const store = useCamStore.getState()
  const before = store.project
  const requestId = store.beginProjectOpen()
  await store.loadProjectFromFile(text, requestId)
  const opened = useCamStore.getState()
  if (opened.project === before) throw new Error('The project could not be opened. See the console for details.')
  if (path) {
    try { await rememberProject(path, opened.project.name, projectThumbnail(JSON.parse(text).thumbnail)) }
    catch { opened.addConsoleEvent({ source: 'project', severity: 'warning', message: 'Project opened, but its recent entry could not be saved.' }) }
  }
  return opened.project.id
}

export async function browseProject(path?: string): Promise<string | undefined> {
  // WO-2725: Save may overwrite this very path. Finish the decision and write
  // before reading, or reopening would silently restore the pre-save contents.
  if (!await askBeforeReplacingProject('open')) return
  const host = projectHost()
  if (host) {
    const file = await host.openProjectFile(path)
    return file ? loadConfirmedProjectText(file.text, file.path) : undefined
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.camproject'
    input.oncancel = () => resolve(undefined)
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) { resolve(undefined); return }
      const reader = new FileReader()
      reader.onerror = () => reject(new Error(reader.error?.message ?? 'The project file could not be read.'))
      reader.onabort = () => resolve(undefined)
      reader.onload = () => {
        if (typeof reader.result !== 'string') { reject(new Error('The project file could not be read.')); return }
        void loadConfirmedProjectText(reader.result).then(resolve, reject)
      }
      reader.readAsText(file)
    }
    input.click()
  })
}
