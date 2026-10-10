export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return `data:${mime};base64,${btoa(bin)}`
}

export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const comma = dataUrl.indexOf(',')
  const head = dataUrl.slice(5, comma)
  const mime = head.split(';')[0] || 'application/octet-stream'
  const bin = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { bytes, mime }
}

/** The picture file as a data: URL, read by the browser off the page's thread (a few MB would otherwise hold it). */
export function fileDataUrl(file: File, bytes: Uint8Array, mime: string): Promise<string> {
  if (typeof FileReader === 'undefined') return Promise.resolve(bytesToDataUrl(bytes, mime))
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      // keep the mime the picture was decoded as (some files arrive with no type)
      resolve(url.startsWith(`data:${mime}`) ? url : `data:${mime};base64,${url.slice(url.indexOf(',') + 1)}`)
    }
    reader.onerror = () => resolve(bytesToDataUrl(bytes, mime))
    reader.readAsDataURL(file)
  })
}

