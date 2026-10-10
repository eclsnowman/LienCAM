// Deterministic pure-JS content hash for import caching (D-007: STEP
// tessellations are cached by (file hash, deflection)).
//
// FNV-1a 64-bit over raw bytes -- same construction as irFingerprint in
// ../ir/types.ts (which hashes canonical text, not bytes, so it is not
// reusable here without editing it; this is the byte-alphabet variant).
// No Math.random, no Date: identical bytes -> identical hash on every run.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over bytes, returned as 16 hex chars. */
export function fnv1a64Bytes(bytes: Uint8Array): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}
