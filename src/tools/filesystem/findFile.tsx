import React from 'react';
import { Text } from 'ink';
import { Tool, ToolCallContext } from '../types.js';
import { DEFAULT_IGNORE_PATTERNS, shouldExclude } from './shared.js';

interface FindFileArgs {
  pattern: string;
  path?: string;
  ignore_patterns?: string[];
}

type FindFileResult = { success: boolean; files: string[] };

function renderFindFileCall(pattern: string, path?: string): string {
  return `Finding "${pattern}" in ${path || '.'}`;
}

export const findFile: Tool<FindFileArgs, FindFileResult> = {
  name: "find_file",
  description: "Finds files by name or pattern within a directory.",
  schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The filename or pattern to search for." },
      path: { type: "string", description: "The directory to start the search from." },
      ignore_patterns: { type: "array", items: { type: "string" }, description: "List of directory names to ignore." }
    },
    required: ["pattern"]
  } as const,
  execute: async ({ pattern, path: startPath = '.', ignore_patterns = [...DEFAULT_IGNORE_PATTERNS] }: FindFileArgs, _ctx?: ToolCallContext): Promise<FindFileResult> => {
    try {
      const fs = await import('node:fs/promises');
      const path = (await import('node:path')).default;

      const globToRegex = (glob: string) => {
        let regexStr = glob.replace(/[.+^${}()[\]\\]/g, '\\$&');
        regexStr = regexStr.replace(/\*/g, '.*');
        regexStr = regexStr.replace(/\?/g, '.');
        return new RegExp(`^${regexStr}$`);
      };
      const patternRegex = globToRegex(pattern);
      const results: string[] = [];
      const visitedDirs = new Set<string>();

      const walk = async (currentDir: string, depth = 0) => {
        if (depth > 20) return;
        const resolved = await fs.realpath(currentDir).catch(() => currentDir);
        if (visitedDirs.has(resolved)) return;
        visitedDirs.add(resolved);
        try {
          const entries = await fs.readdir(currentDir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
              if (shouldExclude(entry.name, ignore_patterns)) continue;
              if (entry.isSymbolicLink()) {
                try {
                  const target = await fs.realpath(fullPath);
                  if (target === currentDir) continue; // self-referencing symlink loop
                } catch { continue; } // unresolved symlink — skip
              }
              await walk(fullPath, depth + 1);
            }
            else if (entry.isFile() && patternRegex.test(entry.name)) results.push(fullPath);
          }
        } catch (err: any) {
          // Skip directories that can't be read (e.g., deleted between test runs)
          if (err.code !== 'ENOENT' && err.code !== 'EACCES') throw err;
        }
      };

      const absoluteStartPath = path.resolve(startPath);
      // Check if the start path exists first
      try {
        await fs.stat(absoluteStartPath);
      } catch (err: any) {
        if (err.code === 'ENOENT') return { success: false, files: [] };
        throw err;
      }
      await walk(absoluteStartPath);
      return { success: true, files: results };
    } catch (error: any) {
      return { success: false, files: [] };
    }
  },
  renderCall: ({ pattern, path: startPath }: FindFileArgs) => (
    <Text color="cyan">{renderFindFileCall(pattern, startPath)}</Text>
  ),
  renderCallText: ({ pattern, path: startPath }: FindFileArgs) =>
    renderFindFileCall(pattern, startPath),
  renderResult: (result: FindFileResult) => (
    <Text color="gray">
      {result.success && result.files.length > 0
        ? `${result.files.length} files found:\n${result.files.join('\n')}`
        : result.success ? 'No files found.' : `Search failed.`}
    </Text>
  )
};
