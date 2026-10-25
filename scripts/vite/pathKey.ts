/**
 * One spelling of a file path, for comparing paths in the build plugins.
 *
 * node:path writes C:\a\b on Windows while Rolldown (Vite 8, performance plan
 * P3.8) and Vite name the same module C:/a/b, so a plain === between the two
 * matches nothing there: the first Windows build failed with "no entry chunk"
 * on every page. Vite compares them through normalizePath, and so does this.
 * Windows paths are also compared without regard to case, as Windows itself
 * does (a drive letter can come as C: or c:). Elsewhere it is normalizePath
 * alone, which leaves an absolute Linux path as it is.
 */
import { normalizePath } from 'vite';

export function pathKey(path: string): string {
  const p = normalizePath(path);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
