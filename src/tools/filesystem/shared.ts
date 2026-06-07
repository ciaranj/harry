/**
 * Shared default patterns for ignoring directories across filesystem tools.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '.h',
  'node_modules',
  '.git',
  'build',
  'dist',
  '__pycache__',
  'venv',
  '.next',
] as const;

/**
 * Returns true if a directory name matches any of the given patterns.
 */
export function shouldExclude(dirName: string, patterns: readonly string[]): boolean {
  return patterns.includes(dirName);
}

// ---------------------------------------------------------------------------
// Path canonicalization & guardrails
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve a path to its canonical absolute form, then verify it lives
 * underneath `baseDir` (defaults to process.cwd()).
 *
 * Steps:
 *   1. `path.resolve()` — make absolute (resolves `..`, `.`).
 *   2. `fs.realpathSync()` — resolve symlinks on disk.
 *   3. `startsWith(baseDir + sep)` — ensure the file is inside the allowed tree.
 *
 * Returns `{ canonical, withinBounds }` so callers can decide whether to
 * allow the file or reject it.
 */
export function resolveCanonicalPath(
  filePath: string,
  baseDir: string = process.cwd()
): { canonical: string; withinBounds: boolean } {
  const resolved = path.resolve(filePath);

  let canonical: string;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    // File may not exist yet (e.g. a new file being written).
    // Fall back to the resolved path — the directory guardrail still
    // applies since the parent directory must exist.
    canonical = resolved;
  }

  const sep = path.sep;
  const withinBounds =
    canonical === baseDir ||
    canonical.startsWith(baseDir + sep);

  return { canonical, withinBounds };
}
