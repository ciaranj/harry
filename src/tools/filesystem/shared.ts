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
