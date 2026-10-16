export interface RecentProject {
  path: string
  name: string
  openedAt: string
  thumbnail?: string
  missing?: boolean
}
export interface ProjectFile { path: string; text: string }
export interface ProjectHost {
  openProjectFile: (path?: string) => Promise<ProjectFile | null>
  recentProjects: () => Promise<RecentProject[]>
  rememberProject: (project: RecentProject) => Promise<void>
  removeRecentProject: (path: string) => Promise<void>
}
export function projectHost(): ProjectHost | undefined {
  const host = (globalThis as typeof globalThis & { liencamHost?: Partial<ProjectHost> }).liencamHost
  return typeof host?.openProjectFile === 'function' ? host as ProjectHost : undefined
}
/** Only a small PNG may ride in the file or recent cache. Never render file-supplied URLs. */
export function projectThumbnail(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 400_000 &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined
}
export async function rememberProject(path: string, name: string, thumbnail?: string): Promise<void> {
  if (!projectHost() || !/\.camproject$/i.test(path)) return
  await projectHost()!.rememberProject({ path, name, thumbnail: projectThumbnail(thumbnail), openedAt: new Date().toISOString() })
}
