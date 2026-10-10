import { importPostFile as convertPostFile, type VendorPostImportResult } from './vendorPostImport/index'

export type { VendorPostImportResult } from './vendorPostImport/index'

/** Keep the source separately from the converted settings: editing a post must
 * never change the file offered by Export original. The picker supplies bytes
 * so BOMs, line endings and non-UTF-8 vendor comments survive unchanged. */
export function importPostFile(source: string, filename: string, bytes?: Uint8Array): VendorPostImportResult {
  const result = convertPostFile(source, filename)
  if (!result.ok || !/\.(pp|cps|scpost|pst)$/i.test(filename)) return result
  const original = bytes ?? new TextEncoder().encode(source)
  const chunks: string[] = []
  for (let offset = 0; offset < original.length; offset += 8192) {
    chunks.push(String.fromCharCode(...original.subarray(offset, offset + 8192)))
  }
  result.config.originalVendorPost = { filename, bytesBase64: btoa(chunks.join('')) }
  return result
}
