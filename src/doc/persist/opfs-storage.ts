import type { BinaryDocumentStorage } from './storage'

type StorageManagerWithOpfs = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>
}

export class OpfsDocumentStorage implements BinaryDocumentStorage {
  private rootPromise: Promise<FileSystemDirectoryHandle> | undefined

  async read(key: string): Promise<Uint8Array | undefined> {
    try {
      const root = await this.root()
      const { dir, name } = await parentDirectory(root, key, false)
      const handle = await dir.getFileHandle(name)
      const file = await handle.getFile()
      return new Uint8Array(await file.arrayBuffer())
    } catch {
      return undefined
    }
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    const root = await this.root()
    const { dir, name } = await parentDirectory(root, key, true)
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(copyToArrayBuffer(bytes))
    await writable.close()
  }

  async remove(key: string): Promise<void> {
    try {
      const root = await this.root()
      const { dir, name } = await parentDirectory(root, key, false)
      await dir.removeEntry(name)
    } catch {
      return
    }
  }

  private root(): Promise<FileSystemDirectoryHandle> {
    if (!this.rootPromise) {
      const storage = navigator.storage as StorageManagerWithOpfs
      if (!storage.getDirectory) throw new Error('OPFS is not available in this browser.')
      this.rootPromise = storage.getDirectory()
    }
    return this.rootPromise
  }
}

async function parentDirectory(
  root: FileSystemDirectoryHandle,
  key: string,
  create: boolean,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = splitKey(key)
  let dir = root
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create })
  return { dir, name: parts[parts.length - 1] }
}

function splitKey(key: string): string[] {
  const parts = key.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error("Invalid storage key '" + key + "'.")
  }
  return parts
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer as ArrayBuffer
}
