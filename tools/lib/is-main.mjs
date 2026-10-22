import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// True when the module at metaUrl is the script node was started with. Node runs the main module from its
// real path, so a script started through a junction or symlink (for example a work lane reached through
// a directory junction) has an argv[1] that differs from import.meta.url. Compare real paths.
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync.native(resolve(process.argv[1])) === realpathSync.native(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
