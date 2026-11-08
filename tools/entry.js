// Shared by the command-line tools.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when this module is what `node` was started with, by any path or symlink. Pass import.meta.url. */
export function isEntryPoint(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/** The default paths are macOS's. Elsewhere the browser would not look there, so say so rather than appear to work. */
export function requireMacOS(what, platform = process.platform) {
  if (platform !== 'darwin') throw new Error(`${what} is only known on macOS, and this is ${platform}. See the README.`);
}
