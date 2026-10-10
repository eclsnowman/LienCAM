export interface BinaryDocumentStorage {
  read(key: string): Promise<Uint8Array | undefined>
  write(key: string, bytes: Uint8Array): Promise<void>
  remove(key: string): Promise<void>
}

export class InMemoryDocumentStorage implements BinaryDocumentStorage {
  private readonly files = new Map<string, Uint8Array>()

  async read(key: string): Promise<Uint8Array | undefined> {
    const bytes = this.files.get(key)
    return bytes ? new Uint8Array(bytes) : undefined
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    this.files.set(key, new Uint8Array(bytes))
  }

  async remove(key: string): Promise<void> {
    this.files.delete(key)
  }

  keys(): string[] {
    return [...this.files.keys()].sort()
  }
}
