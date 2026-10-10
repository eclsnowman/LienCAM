// NODE-TEST-ONLY fixture path helper. Deliberately NOT exported from
// ./index.ts: it imports node:fs/node:path and must never reach a browser
// bundle.
//
// Some Sample Parts fixtures are untracked and exist only in the sibling MAIN
// working copy (e.g. fix_freeform.step, fix_plate_holes.step); the worktree
// carries others (e.g. "Step Test With Holes.step"). Probe the worktree
// first, then the main copy. Fixture files are NOT copied into the repo --
// tests read them where they live.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// this file lives at <root>/src/cam3d/input/, so root is three levels up.
const worktreeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// WO-268: "LienCNC CAM" here is a REAL DIRECTORY NAME on disk (the predecessor
// working copy), not the product name. The app is LienCAM; this path is not.
// Renaming this string makes every main-copy fixture probe miss.
const MAIN_COPY_SAMPLE_PARTS = 'D:\\Google Drive\\Documents\\04 - Github\\LienCNC CAM\\Sample Parts';

/**
 * Resolve a Sample Parts fixture by name, probing the worktree then the main
 * working copy. Throws with BOTH probed paths when the file is missing.
 */
export function resolveSamplePartPath(name: string): string {
  const candidates = [
    join(worktreeRoot, 'Sample Parts', name),
    join(MAIN_COPY_SAMPLE_PARTS, name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Sample Parts fixture "${name}" not found. Probed:\n` +
      candidates.map((c) => `  ${c}`).join('\n'),
  );
}
