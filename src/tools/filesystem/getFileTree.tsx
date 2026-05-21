import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { Text } from 'ink';
import { Tool, ToolCallContext } from '../types.js';
import { DEFAULT_IGNORE_PATTERNS } from './shared.js';

interface GetFileTreeArgs {
  path: string;
  max_depth?: number;
  ignore_patterns?: string[];
}

type FileTreeResult = {
  success: boolean;
  tree?: string;
  max_depth?:number;
  failure_reason?: string;
};

function renderGetFileTreeCall(dirPath: string, max_depth?: number): string {
  return `Reading directory tree: ${dirPath} (depth: ${max_depth || 3})`;
}

export const getFileTree: Tool<GetFileTreeArgs, FileTreeResult> = {
  name: "get_file_tree",
  description: "Returns a recursive directory tree structure.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The root path to generate the tree from." },
      max_depth: { type: "number", description: "Maximum depth to recurse, defaults to 3." },
      ignore_patterns: { type: "array", items: { type: "string" }, description: "List of directory names to ignore." }
    },
    required: ["path"]
  } as const,
  execute: async (args: GetFileTreeArgs, _ctx?: ToolCallContext): Promise<FileTreeResult> => {
    const { path: dirPath, max_depth = 3, ignore_patterns = [...DEFAULT_IGNORE_PATTERNS] } = args;
    try {
      const formatSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
      };

      const build = async (p: string, currentDepth: number, ignorePatterns: string[], indent = ""): Promise<string> => {
        if (currentDepth >= max_depth) return "";
        let entries;
        try { entries = await readdir(p, { withFileTypes: true }); }
        catch (e: any) { return `${indent}[DIR] ${path.basename(p)} (Permission Denied)\n`; }

        let tree = "";
        const sortedEntries = entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (const e of sortedEntries) {
          if (ignorePatterns.some(pattern => e.name === pattern || e.name.startsWith(pattern + '/'))) continue;
          const fp = path.join(p, e.name);
          try {
            const stats = await stat(fp);
            if (e.isDirectory()) {
              tree += `${indent}[DIR] ${e.name}\n`;
              tree += await build(fp, currentDepth + 1, ignorePatterns, indent + "  ");
            } else {
              tree += `${indent}[FILE ${formatSize(stats.size)}] ${e.name}\n`;
            }
          } catch (err: any) {
            tree += `${indent}[FILE ?] ${e.name}\n`;
          }
        }
        return tree;
      };
      const tree = await build(dirPath, 0, ignore_patterns);
      return { success: true, tree, max_depth };
    } catch (error: any) {
      return { success: false, failure_reason: `Error: ${error.message}` };
    }
  },
  renderCall: ({ path: p, max_depth }: GetFileTreeArgs) => (
    <Text color="cyan">{renderGetFileTreeCall(p, max_depth)}</Text>
  ),
  renderCallText: ({ path: p, max_depth }: GetFileTreeArgs) =>
    renderGetFileTreeCall(p, max_depth),
  renderResult: (result: FileTreeResult) => (
    <Text color="gray">{result.tree}</Text>
  )
};
