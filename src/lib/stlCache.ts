// IndexedDB cache for STL ArrayBuffers, keyed by geometry ID.
// Survives page refreshes; allows the viewport to restore parts automatically.

const DB_NAME = 'lien-cam-stl-cache'
const STORE = 'stl-buffers'
const VERSION = 2   // v2 adds 'geometry2d' store (geometry2dCache.ts)

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('stl-buffers')) db.createObjectStore('stl-buffers')
      if (!db.objectStoreNames.contains('geometry2d'))  db.createObjectStore('geometry2d')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function cacheSTL(id: string, buffer: ArrayBuffer): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(buffer, id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function loadCachedSTL(id: string): Promise<ArrayBuffer | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function removeCachedSTL(id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
